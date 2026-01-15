import http from "http";
import { randomUUID } from "crypto";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const API_KEY = process.env.UNIFI_API_KEY;
if (!API_KEY) throw new Error("UNIFI_API_KEY is required");

const BASE_URL = (process.env.UNIFI_API_BASE_URL || "https://api.ui.com").replace(/\/+$/, "");
const DEFAULT_VERSION = (process.env.UNIFI_API_VERSION || "v1").replace(/^\/+|\/+$/g, "");
const ENDPOINT = process.env.MCP_HTTP_ENDPOINT || "/mcp";
const PORT = Number(process.env.PORT || process.env.MCP_SERVER_PORT || 3000);

// ---------- UniFi helpers ----------
function buildUrl(path, query) {
  let p = path || "";
  if (!p.startsWith("/")) p = "/" + p;

  if (!p.startsWith("/v1/") && !p.startsWith("/ea/")) {
    const prefix = `/${DEFAULT_VERSION}`;
    if (!p.startsWith(prefix + "/") && p !== prefix) p = prefix + (p === "/" ? "" : p);
  }

  const url = new URL(BASE_URL + p);

  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item === undefined || item === null) continue;
          url.searchParams.append(k, String(item));
        }
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

async function unifiFetch(method, path, { query, body } = {}) {
  const url = buildUrl(path, query);

  const headers = {
    "X-API-Key": API_KEY,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };

  let payload;
  if (body !== undefined && body !== null && method !== "GET" && method !== "HEAD") {
    payload = JSON.stringify(body);
  }

  console.log(`[UniFi] ${method} ${url.replace(BASE_URL, "")}${payload ? " (body)": ""}`);

  const res = await fetch(url, { method, headers, body: payload });
  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();

  let data;
  if (contentType.includes("application/json")) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  } else {
    data = { raw: text };
  }

  if (!res.ok) {
    console.error(`[UniFi] ${res.status} ${res.statusText}`, data);
    const err = new Error(`UniFi API ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  
  console.log(`[UniFi] ${res.status} OK`);
  return data;
}

function asTextResponse(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// ---------- MCP server builder ----------
function buildMcpServer() {
  const server = new McpServer({ name: "unifi-cloud-mcp-http", version: "0.3.1" });

  server.tool("health", {}, async () => {
    console.log("[MCP] health check");
    return asTextResponse({ status: "ok", baseUrl: BASE_URL, timestamp: new Date().toISOString() });
  });

  server.tool(
    "unifi_list_hosts",
    {
      pageSize: z.string().optional().describe("Number of results per page (default: 20)"),
      nextToken: z.string().optional().describe("Token from previous response for pagination"),
    },
    async (args) => {
      console.log("[API] GET /v1/hosts", args);
      try {
        const data = await unifiFetch("GET", "/v1/hosts", { query: args });
        return asTextResponse(data);
      } catch (e) {
        console.error("[API] GET /v1/hosts failed:", e.message, e.data);
        throw e;
      }
    }
  );

  server.tool(
    "unifi_get_host_by_id",
    { id: z.string().min(1).describe("Host ID to retrieve details for") },
    async ({ id }) => {
      console.log("[API] GET /v1/hosts/:id", { id });
      try {
        const data = await unifiFetch("GET", `/v1/hosts/${encodeURIComponent(id)}`);
        return asTextResponse(data);
      } catch (e) {
        console.error("[API] GET /v1/hosts/:id failed:", e.message, e.data);
        throw e;
      }
    }
  );

  server.tool(
    "unifi_list_sites",
    {
      pageSize: z.string().optional().describe("Number of results per page (default: 20)"),
      nextToken: z.string().optional().describe("Token from previous response for pagination"),
    },
    async (args) => {
      console.log("[API] GET /v1/sites", args);
      try {
        const data = await unifiFetch("GET", "/v1/sites", { query: args });
        return asTextResponse(data);
      } catch (e) {
        console.error("[API] GET /v1/sites failed:", e.message, e.data);
        throw e;
      }
    }
  );

  server.tool(
    "unifi_list_devices",
    {
      hostIds: z.array(z.string()).optional().describe("Filter by host IDs"),
      time: z.string().optional().describe("Time parameter for device metrics"),
      pageSize: z.string().optional().describe("Number of results per page (default: 20)"),
      nextToken: z.string().optional().describe("Token from previous response for pagination"),
    },
    async (args) => {
      console.log("[API] GET /v1/devices", args);
      try {
        const data = await unifiFetch("GET", "/v1/devices", { query: args });
        return asTextResponse(data);
      } catch (e) {
        console.error("[API] GET /v1/devices failed:", e.message, e.data);
        throw e;
      }
    }
  );

  server.tool(
    "unifi_get_isp_metrics",
    {
      type: z.enum(["5m", "1h"]).describe("Metric type: 5m or 1h aggregation"),
      beginTimestamp: z.string().optional().describe("Start time (RFC3339 or epoch milliseconds)"),
      endTimestamp: z.string().optional().describe("End time (RFC3339 or epoch milliseconds)"),
      duration: z.enum(["24h", "7d", "30d"]).optional().describe("Preset duration (overrides begin/endTimestamp)"),
    },
    async ({ type, beginTimestamp, endTimestamp, duration }) => {
      const query = { beginTimestamp, endTimestamp, duration };
      console.log("[API] GET /ea/isp-metrics/:type", { type, ...query });
      try {
        const data = await unifiFetch("GET", `/ea/isp-metrics/${type}`, { query });
        return asTextResponse(data);
      } catch (e) {
        console.error("[API] GET /ea/isp-metrics/:type failed:", e.message, e.data);
        throw e;
      }
    }
  );

  server.tool(
    "unifi_query_isp_metrics",
    {
      type: z.enum(["5m", "1h"]).describe("Metric type: 5m or 1h aggregation"),
      sites: z.array(z.object({ siteId: z.string().min(1) }).passthrough()).describe("Array of site objects with siteId"),
    },
    async ({ type, sites }) => {
      console.log("[API] POST /ea/isp-metrics/:type/query", { type, sites });
      try {
        const data = await unifiFetch("POST", `/ea/isp-metrics/${type}/query`, { body: { sites } });
        return asTextResponse(data);
      } catch (e) {
        console.error("[API] POST /ea/isp-metrics/:type/query failed:", e.message, e.data);
        throw e;
      }
    }
  );

  server.tool(
    "unifi_list_sdwan_configs",
    {},
    async () => {
      console.log("[API] GET /ea/sd-wan-configs");
      try {
        const data = await unifiFetch("GET", "/ea/sd-wan-configs");
        return asTextResponse(data);
      } catch (e) {
        console.error("[API] GET /ea/sd-wan-configs failed:", e.message, e.data);
        throw e;
      }
    }
  );

  server.tool(
    "unifi_get_sdwan_config_by_id",
    { id: z.string().min(1).describe("SD-WAN config ID") },
    async ({ id }) => {
      console.log("[API] GET /ea/sd-wan-configs/:id", { id });
      try {
        const data = await unifiFetch("GET", `/ea/sd-wan-configs/${encodeURIComponent(id)}`);
        return asTextResponse(data);
      } catch (e) {
        console.error("[API] GET /ea/sd-wan-configs/:id failed:", e.message, e.data);
        throw e;
      }
    }
  );

  server.tool(
    "unifi_get_sdwan_config_status",
    { id: z.string().min(1).describe("SD-WAN config ID") },
    async ({ id }) => {
      console.log("[API] GET /ea/sd-wan-configs/:id/status", { id });
      try {
        const data = await unifiFetch("GET", `/ea/sd-wan-configs/${encodeURIComponent(id)}/status`);
        return asTextResponse(data);
      } catch (e) {
        console.error("[API] GET /ea/sd-wan-configs/:id/status failed:", e.message, e.data);
        throw e;
      }
    }
  );

  server.tool(
    "unifi_request",
    {
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET").describe("HTTP method"),
      path: z.string().min(1).describe("API path (e.g., /v1/hosts or /ea/isp-metrics/5m)"),
      query: z.record(z.any()).optional().describe("Query parameters object"),
      body: z.any().optional().describe("Request body for POST/PUT/PATCH"),
    },
    async ({ method, path, query, body }) => {
      console.log("[API]", method, path, query || body ? { query, body } : "");
      try {
        const data = await unifiFetch(method, path, { query, body });
        return asTextResponse(data);
      } catch (e) {
        console.error(`[API] ${method} ${path} failed:`, e.message, e.data);
        throw e;
      }
    }
  );

  return server;
}

// ---------- Streamable HTTP routing ----------
const sessions = new Map(); // sessionId -> { transport, server }

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
  });
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(obj));
}

function getSessionId(req) {
  // header name is case-insensitive; Node lowercases incoming headers
  const h = req.headers["mcp-session-id"];
  if (!h) return undefined;
  return Array.isArray(h) ? String(h[0]) : String(h);
}

function isInitialize(body) {
  return body && typeof body === "object" && body.method === "initialize";
}

async function getOrCreateTransport(req, body) {
  const sid = getSessionId(req);
  if (sid && sessions.has(sid)) {
    console.log(`[Session] Reusing session ${sid}`);
    return sessions.get(sid);
  }

  // Allow initialize to create a new session even if a sid header is present
  if (isInitialize(body)) {
    console.log("[Session] Creating new session (initialize)");
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await server.connect(transport);
    return { transport, server, isNew: true };
  }

  return null;
}

const httpServer = http.createServer(async (req, res) => {
  if (!req.url || !req.url.startsWith(ENDPOINT)) {
    res.statusCode = 404;
    return res.end("Not found");
  }

  const method = (req.method || "GET").toUpperCase();
  const body = method === "POST" ? await readBody(req) : undefined;

  console.log(`[HTTP] ${method} ${req.url}${body ? " (data)" : ""}`);

  const sessionObj = await getOrCreateTransport(req, body);
  if (!sessionObj) {
    const msg =
      "No active session. Open WebUI should POST initialize first; subsequent calls must include Mcp-Session-Id header.";
    console.error("[Session] Error:", msg);
    return sendJson(res, 400, { error: msg });
  }

  const { transport } = sessionObj;

  try {
    await transport.handleRequest(req, res, body);

    // On initialize, the transport sets the session header on the response.
    if (sessionObj.isNew) {
      const newSid = res.getHeader("mcp-session-id");
      if (newSid) {
        const sidStr = String(newSid);
        sessions.set(sidStr, { transport: sessionObj.transport, server: sessionObj.server });
        console.log(`[Session] New session created: ${sidStr}`);
      }
    }
  } catch (e) {
    console.error("[HTTP] Error:", e.message);
    return sendJson(res, 500, { error: String(e?.message || e) });
  }
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP Server: http://0.0.0.0:${PORT}${ENDPOINT}`);
  console.log(`UniFi API: ${BASE_URL}`);
  console.log("Ready for connections from Open Web UI or ChatGPT");
});
