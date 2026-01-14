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
  };

  let payload;
  if (body !== undefined && body !== null && method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

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
    const err = new Error(`UniFi API ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function asTextResponse(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// ---------- MCP server builder ----------
function buildMcpServer() {
  const server = new McpServer({ name: "unifi-cloud-mcp-http", version: "0.3.1" });

  server.tool("health", {}, async () => asTextResponse({ status: "ok", baseUrl: BASE_URL }));

  server.tool(
    "unifi_list_hosts",
    {
      pageSize: z.string().optional(),
      nextToken: z.string().optional(),
    },
    async (args) => asTextResponse(await unifiFetch("GET", "/v1/hosts", { query: args }))
  );

  server.tool(
    "unifi_get_host_by_id",
    { id: z.string().min(1) },
    async ({ id }) => asTextResponse(await unifiFetch("GET", `/v1/hosts/${encodeURIComponent(id)}`))
  );

  server.tool(
    "unifi_list_sites",
    {
      pageSize: z.string().optional(),
      nextToken: z.string().optional(),
    },
    async (args) => asTextResponse(await unifiFetch("GET", "/v1/sites", { query: args }))
  );

  server.tool(
    "unifi_list_devices",
    {
      hostIds: z.array(z.string()).optional(),
      time: z.string().optional(),
      pageSize: z.string().optional(),
      nextToken: z.string().optional(),
    },
    async (args) => asTextResponse(await unifiFetch("GET", "/v1/devices", { query: args }))
  );

  server.tool(
    "unifi_get_isp_metrics",
    {
      type: z.enum(["5m", "1h"]),
      beginTimestamp: z.string().optional(),
      endTimestamp: z.string().optional(),
      duration: z.enum(["24h", "7d", "30d"]).optional(),
    },
    async ({ type, beginTimestamp, endTimestamp, duration }) => {
      const query = { beginTimestamp, endTimestamp, duration };
      return asTextResponse(await unifiFetch("GET", `/ea/isp-metrics/${type}`, { query }));
    }
  );

  server.tool(
    "unifi_query_isp_metrics",
    {
      type: z.enum(["5m", "1h"]),
      sites: z.array(z.object({ siteId: z.string().min(1) }).passthrough()),
    },
    async ({ type, sites }) =>
      asTextResponse(await unifiFetch("POST", `/ea/isp-metrics/${type}/query`, { body: { sites } }))
  );

  server.tool("unifi_list_sdwan_configs", {}, async () =>
    asTextResponse(await unifiFetch("GET", "/ea/sd-wan-configs"))
  );

  server.tool(
    "unifi_get_sdwan_config_by_id",
    { id: z.string().min(1) },
    async ({ id }) => asTextResponse(await unifiFetch("GET", `/ea/sd-wan-configs/${encodeURIComponent(id)}`))
  );

  server.tool(
    "unifi_get_sdwan_config_status",
    { id: z.string().min(1) },
    async ({ id }) =>
      asTextResponse(await unifiFetch("GET", `/ea/sd-wan-configs/${encodeURIComponent(id)}/status`))
  );

  server.tool(
    "unifi_request",
    {
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      path: z.string().min(1),
      query: z.record(z.any()).optional(),
      body: z.any().optional(),
    },
    async ({ method, path, query, body }) => asTextResponse(await unifiFetch(method, path, { query, body }))
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
  return req.headers["mcp-session-id"];
}

function isInitialize(body) {
  return body && typeof body === "object" && body.method === "initialize";
}

async function getOrCreateTransport(req, body) {
  const sid = getSessionId(req);
  if (sid && sessions.has(sid)) return sessions.get(sid);

  if (!sid && isInitialize(body)) {
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

  const sessionObj = await getOrCreateTransport(req, body);
  if (!sessionObj) {
    return sendJson(res, 400, {
      error:
        "No active session. Open WebUI should POST initialize first; subsequent calls must include Mcp-Session-Id header.",
    });
  }

  const { transport } = sessionObj;

  try {
    await transport.handleRequest(req, res, body);

    // On initialize, the transport sets the session header on the response.
    if (sessionObj.isNew) {
      const newSid = res.getHeader("mcp-session-id");
      if (newSid) sessions.set(String(newSid), { transport: sessionObj.transport, server: sessionObj.server });
    }
  } catch (e) {
    return sendJson(res, 500, { error: String(e?.message || e) });
  }
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP Streamable HTTP listening on http://0.0.0.0:${PORT}${ENDPOINT}`);
});
