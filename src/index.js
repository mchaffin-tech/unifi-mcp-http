import { Hono } from "hono";
import { toFetchResponse, toReqRes } from "fetch-to-node";
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

/**
 * UniFi request helpers (unchanged from your version)
 */
function buildUrl(path, query) {
  let p = path || "";
  if (!p.startsWith("/")) p = "/" + p;

  // If caller included /v1 or /ea, keep it; otherwise prefix with DEFAULT_VERSION.
  if (!p.startsWith("/v1/") && !p.startsWith("/ea/")) {
    const prefix = `/${DEFAULT_VERSION}`;
    if (!p.startsWith(prefix + "/") && p !== prefix) {
      p = prefix + (p === "/" ? "" : p);
    }
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
    "Accept": "application/json"
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

/**
 * MCP server builder (register tools here)
 */
function buildMcpServer() {
  const server = new McpServer({
    name: "unifi-cloud-mcp-http",
    version: "0.3.0"
  });

  server.tool("health", {}, async () => {
    return asTextResponse({ status: "ok", baseUrl: BASE_URL });
  });

  // GET /v1/hosts
  server.tool(
    "unifi_list_hosts",
    {
      pageSize: z.string().optional().describe("Items per page (string, e.g. '10')"),
      nextToken: z.string().optional().describe("Pagination token")
    },
    async (args) => asTextResponse(await unifiFetch("GET", "/v1/hosts", { query: args }))
  );

  // GET /v1/hosts/:id
  server.tool(
    "unifi_get_host_by_id",
    { id: z.string().min(1).describe("Host ID") },
    async ({ id }) => asTextResponse(await unifiFetch("GET", `/v1/hosts/${encodeURIComponent(id)}`))
  );

  // GET /v1/sites
  server.tool(
    "unifi_list_sites",
    {
      pageSize: z.string().optional().describe("Items per page (string, e.g. '10')"),
      nextToken: z.string().optional().describe("Pagination token")
    },
    async (args) => asTextResponse(await unifiFetch("GET", "/v1/sites", { query: args }))
  );

  // GET /v1/devices
  server.tool(
    "unifi_list_devices",
    {
      hostIds: z.array(z.string()).optional().describe("Host IDs filter (repeated query param)"),
      time: z.string().optional().describe("RFC3339 timestamp, e.g. 2025-06-17T02:45:58Z"),
      pageSize: z.string().optional().describe("Items per page (string, e.g. '10')"),
      nextToken: z.string().optional().describe("Pagination token")
    },
    async (args) => asTextResponse(await unifiFetch("GET", "/v1/devices", { query: args }))
  );

  // GET /ea/isp-metrics/:type
  server.tool(
    "unifi_get_isp_metrics",
    {
      type: z.enum(["5m", "1h"]).describe("Metric interval type"),
      beginTimestamp: z.string().optional().describe("RFC3339 beginTimestamp"),
      endTimestamp: z.string().optional().describe("RFC3339 endTimestamp"),
      duration: z.enum(["24h", "7d", "30d"]).optional().describe("Relative duration")
    },
    async ({ type, beginTimestamp, endTimestamp, duration }) => {
      const query = { beginTimestamp, endTimestamp, duration };
      return asTextResponse(await unifiFetch("GET", `/ea/isp-metrics/${type}`, { query }));
    }
  );

  // POST /ea/isp-metrics/:type/query
  server.tool(
    "unifi_query_isp_metrics",
    {
      type: z.enum(["5m", "1h"]).describe("Metric interval type"),
      sites: z.array(z.object({ siteId: z.string().min(1) }).passthrough()).describe("Array of site query objects")
    },
    async ({ type, sites }) =>
      asTextResponse(await unifiFetch("POST", `/ea/isp-metrics/${type}/query`, { body: { sites } }))
  );

  // GET /ea/sd-wan-configs
  server.tool("unifi_list_sdwan_configs", {}, async () => {
    return asTextResponse(await unifiFetch("GET", "/ea/sd-wan-configs"));
  });

  // GET /ea/sd-wan-configs/:id
  server.tool(
    "unifi_get_sdwan_config_by_id",
    { id: z.string().min(1).describe("SD-WAN config ID (UUID)") },
    async ({ id }) => asTextResponse(await unifiFetch("GET", `/ea/sd-wan-configs/${encodeURIComponent(id)}`))
  );

  // GET /ea/sd-wan-configs/:id/status
  server.tool(
    "unifi_get_sdwan_config_status",
    { id: z.string().min(1).describe("SD-WAN config ID (UUID)") },
    async ({ id }) =>
      asTextResponse(await unifiFetch("GET", `/ea/sd-wan-configs/${encodeURIComponent(id)}/status`))
  );

  // Generic request
  server.tool(
    "unifi_request",
    {
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      path: z.string().min(1).describe("Path like /v1/sites or /ea/isp-metrics/5m"),
      query: z.record(z.any()).optional().describe("Query params object; arrays become repeated keys"),
      body: z.any().optional().describe("JSON body")
    },
    async ({ method, path, query, body }) => asTextResponse(await unifiFetch(method, path, { query, body }))
  );

  return server;
}

/**
 * Streamable HTTP transport/session routing
 * - POST /mcp: initialize + client messages
 * - GET /mcp: SSE stream (requires Mcp-Session-Id)
 * - DELETE /mcp: end session (requires Mcp-Session-Id)
 *
 * This is how Streamable HTTP server transport is intended to be used with Node req/res. :contentReference[oaicite:3]{index=3}
 */
const sessions = new Map(); // sessionId -> { transport, server }

function getSessionId(headers) {
  // Spec header is "Mcp-Session-Id" (case-insensitive); Node exposes lowercased keys commonly.
  return headers["mcp-session-id"] || headers["Mcp-Session-Id"];
}

function isInitialize(body) {
  return body && typeof body === "object" && body.method === "initialize";
}

async function getOrCreateSessionTransport(reqHeaders, body) {
  const sessionId = getSessionId(reqHeaders);
  if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId);

  // Create a new stateful session only on initialize.
  if (!sessionId && isInitialize(body)) {
    const server = buildMcpServer();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID()
    });

    // Connect server<->transport
    await server.connect(transport);

    // Session id is generated during initialization handling; we capture it after handleRequest by reading res header.
    // We'll store it in sessions map in the route once we see the response header.
    return { transport, server, isNew: true };
  }

  return null;
}

const app = new Hono();

// Handle POST/GET/DELETE on the same endpoint path
app.all(ENDPOINT, async (c) => {
  const { req, res } = toReqRes(c.req.raw);
  const method = c.req.method.toUpperCase();

  const body =
    method === "POST"
      ? await c.req.json().catch(() => null)
      : undefined;

  const sessionObj = await getOrCreateSessionTransport(req.headers, body);
  if (!sessionObj) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error:
          "No active session. Send an initialize request first (POST with JSON-RPC method 'initialize'), then retry using the Mcp-Session-Id header."
      })
    );
    return toFetchResponse(res);
  }

  const { transport } = sessionObj;

  try {
    await transport.handleRequest(req, res, body);

    // If this was a new session, capture the session id from the response header and store it.
    if (sessionObj.isNew) {
      const newSessionId =
        res.getHeader("mcp-session-id") ||
        res.getHeader("Mcp-Session-Id");

      if (newSessionId) {
        sessions.set(String(newSessionId), { transport: sessionObj.transport, server: sessionObj.server });
      }
    }

    // Clean up if the client disconnects
    res.on("close", () => {
      const sid = res.getHeader("mcp-session-id") || res.getHeader("Mcp-Session-Id");
      if (sid && sessions.has(String(sid))) sessions.delete(String(sid));
      try { transport.close(); } catch {}
      try { sessionObj.server?.close?.(); } catch {}
    });

    return toFetchResponse(res);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: String(err?.message || err) }));
    return toFetchResponse(res);
  }
});

export default app;

// Start Node server (Hono runs on fetch; simplest is built-in node http createServer wrapper)
import http from "http";

http.createServer((req, res) => {
  app.fetch(req, { res }).then(async (response) => {
    // Hono's fetch returns a Response; write it out to Node res
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  });
}).listen(PORT, "0.0.0.0", () => {
  console.log(`MCP Streamable HTTP listening on http://0.0.0.0:${PORT}${ENDPOINT}`);
});
