import { FastMCP } from "fastmcp";
import { z } from "zod";

const API_KEY = process.env.UNIFI_API_KEY;
if (!API_KEY) throw new Error("UNIFI_API_KEY is required");

const BASE_URL = (process.env.UNIFI_API_BASE_URL || "https://api.ui.com").replace(/\/+$/, "");
const DEFAULT_VERSION = (process.env.UNIFI_API_VERSION || "v1").replace(/^\/+|\/+$/g, "");
const ENDPOINT = process.env.MCP_HTTP_ENDPOINT || "/mcp";
const PORT = Number(process.env.PORT || 3000);

function buildUrl(path, query) {
  let p = path || "";
  if (!p.startsWith("/")) p = "/" + p;

  // If the caller already included /v1 or /ea, keep it.
  // Otherwise prefix with the configured default version (typically v1).
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
        // repeat keys for arrays: hostIds=a&hostIds=b
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

const server = new FastMCP({
  name: "unifi-cloud-mcp-http",
  version: "0.2.0",
  instructions:
    "MCP server over HTTP streaming for UniFi Site Manager API (cloud). Use unifi_* tools to query hosts/sites/devices and metrics.",
});

server.addTool({
  name: "health",
  description: "Health check for this MCP server.",
  execute: async () => asTextResponse({ status: "ok", baseUrl: BASE_URL }),
});

/**
 * Site Manager API tools (as documented at developer.ui.com/site-manager-api/)
 */

// GET /v1/hosts (pagination: pageSize, nextToken)
server.addTool({
  name: "unifi_list_hosts",
  description: "List hosts (GET /v1/hosts). Supports pagination via pageSize and nextToken.",
  parameters: z.object({
    pageSize: z.string().optional().describe("Number of items per page (string per API docs, e.g. '10')"),
    nextToken: z.string().optional().describe("Pagination token for next page"),
  }).optional(),
  execute: async (args = {}) => asTextResponse(await unifiFetch("GET", "/v1/hosts", { query: args })),
});

// GET /v1/hosts/:id
server.addTool({
  name: "unifi_get_host_by_id",
  description: "Get host details by id (GET /v1/hosts/:id).",
  parameters: z.object({
    id: z.string().min(1).describe("Host ID"),
  }),
  execute: async ({ id }) => asTextResponse(await unifiFetch("GET", `/v1/hosts/${encodeURIComponent(id)}`)),
});

// GET /v1/sites (pagination)
server.addTool({
  name: "unifi_list_sites",
  description: "List sites (GET /v1/sites). Supports pagination via pageSize and nextToken.",
  parameters: z.object({
    pageSize: z.string().optional().describe("Number of items per page (string per API docs, e.g. '10')"),
    nextToken: z.string().optional().describe("Pagination token for next page"),
  }).optional(),
  execute: async (args = {}) => asTextResponse(await unifiFetch("GET", "/v1/sites", { query: args })),
});

// GET /v1/devices (filters + pagination)
server.addTool({
  name: "unifi_list_devices",
  description:
    "List devices (GET /v1/devices). Supports filters hostIds[] and time (RFC3339) and pagination pageSize/nextToken.",
  parameters: z.object({
    hostIds: z.array(z.string()).optional().describe("List of host IDs to filter results (repeats hostIds query key)"),
    time: z.string().optional().describe("Last processed timestamp of devices (RFC3339), e.g. 2025-06-17T02:45:58Z"),
    pageSize: z.string().optional().describe("Number of items per page (string per API docs, e.g. '10')"),
    nextToken: z.string().optional().describe("Pagination token for next page"),
  }).optional(),
  execute: async (args = {}) => {
    // API uses hostIds[] in docs; repeated 'hostIds' key is typically accepted. We'll use 'hostIds' as key.
    const query = { ...args };
    if (query.hostIds) {
      query.hostIds = query.hostIds;
    }
    return asTextResponse(await unifiFetch("GET", "/v1/devices", { query }));
  },
});

// GET /ea/isp-metrics/:type  (type: 5m | 1h)
server.addTool({
  name: "unifi_get_isp_metrics",
  description:
    "Get ISP metrics (GET /ea/isp-metrics/:type). type is '5m' or '1h'. Use duration OR beginTimestamp/endTimestamp (RFC3339).",
  parameters: z.object({
    type: z.enum(["5m", "1h"]).describe("Metric interval type"),
    beginTimestamp: z.string().optional().describe("RFC3339 beginTimestamp"),
    endTimestamp: z.string().optional().describe("RFC3339 endTimestamp"),
    duration: z.enum(["24h", "7d", "30d"]).optional().describe("Relative duration (mutually exclusive with timestamps)"),
  }),
  execute: async ({ type, beginTimestamp, endTimestamp, duration }) => {
    const query = { beginTimestamp, endTimestamp, duration };
    return asTextResponse(await unifiFetch("GET", `/ea/isp-metrics/${type}`, { query }));
  },
});

// POST /ea/isp-metrics/:type/query
server.addTool({
  name: "unifi_query_isp_metrics",
  description:
    "Query ISP metrics (POST /ea/isp-metrics/:type/query). type is '5m' or '1h'. Body must include 'sites' array (per docs).",
  parameters: z.object({
    type: z.enum(["5m", "1h"]).describe("Metric interval type"),
    sites: z.array(z.object({ siteId: z.string().min(1) }).passthrough()).describe("Array of site query objects"),
  }),
  execute: async ({ type, sites }) =>
    asTextResponse(await unifiFetch("POST", `/ea/isp-metrics/${type}/query`, { body: { sites } })),
});

// GET /ea/sd-wan-configs
server.addTool({
  name: "unifi_list_sdwan_configs",
  description: "List SD-WAN configs (GET /ea/sd-wan-configs).",
  execute: async () => asTextResponse(await unifiFetch("GET", "/ea/sd-wan-configs")),
});

// GET /ea/sd-wan-configs/:id
server.addTool({
  name: "unifi_get_sdwan_config_by_id",
  description: "Get SD-WAN config by id (GET /ea/sd-wan-configs/:id).",
  parameters: z.object({
    id: z.string().min(1).describe("SD-WAN config ID (UUID)"),
  }),
  execute: async ({ id }) => asTextResponse(await unifiFetch("GET", `/ea/sd-wan-configs/${encodeURIComponent(id)}`)),
});

// GET /ea/sd-wan-configs/:id/status
server.addTool({
  name: "unifi_get_sdwan_config_status",
  description: "Get SD-WAN config status (GET /ea/sd-wan-configs/:id/status).",
  parameters: z.object({
    id: z.string().min(1).describe("SD-WAN config ID (UUID)"),
  }),
  execute: async ({ id }) =>
    asTextResponse(await unifiFetch("GET", `/ea/sd-wan-configs/${encodeURIComponent(id)}/status`)),
});

// Generic request tool
server.addTool({
  name: "unifi_request",
  description:
    "Generic UniFi API request. Provide a path like '/v1/sites' or '/ea/isp-metrics/5m'. If you omit /v1 or /ea, it prefixes with UNIFI_API_VERSION (default v1).",
  parameters: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    path: z.string().min(1).describe("Request path, e.g. /v1/sites or /ea/isp-metrics/5m"),
    query: z.record(z.any()).optional().describe("Optional query params object (arrays become repeated keys)"),
    body: z.any().optional().describe("Optional JSON body"),
  }),
  execute: async ({ method, path, query, body }) => asTextResponse(await unifiFetch(method, path, { query, body })),
});

// Start HTTP streaming transport
await server.start({
  transportType: "httpStream",
  httpStream: {
    endpoint: ENDPOINT,
    port: PORT,
  },
});

console.log(`MCP HTTP streaming listening on :${PORT}${ENDPOINT}`);
