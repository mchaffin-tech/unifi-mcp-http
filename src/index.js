import { FastMCP } from "fastmcp";
import { z } from "zod";

const API_KEY = process.env.UNIFI_API_KEY;
if (!API_KEY) {
  throw new Error("UNIFI_API_KEY is required");
}

const BASE_URL = (process.env.UNIFI_API_BASE_URL || "https://api.ui.com").replace(/\/+$/, "");
const API_VERSION = (process.env.UNIFI_API_VERSION || "v1").replace(/^\/+|\/+$/g, "");
const ENDPOINT = process.env.MCP_HTTP_ENDPOINT || "/mcp";
const PORT = Number(process.env.PORT || 3000);

function buildUrl(path, query) {
  let p = path || "";
  if (!p.startsWith("/")) p = "/" + p;

  // If caller provides a versioned path already, leave it as-is.
  // Otherwise, prefix with "/{API_VERSION}".
  const versionPrefix = `/${API_VERSION}/`;
  if (!p.startsWith("/v1/") && !p.startsWith("/ea/")) {
    // Only prefix if path doesn't already include a version prefix.
    if (!p.startsWith(versionPrefix)) {
      p = `/${API_VERSION}` + (p === "/" ? "" : p);
    }
  }

  const url = new URL(BASE_URL + p);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
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
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
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
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

const server = new FastMCP({
  name: "unifi-cloud-mcp-http",
  version: "0.1.0",
  instructions:
    "MCP server over HTTP streaming for UniFi Site Manager API. Use the unifi_* tools to query sites/devices/hosts.",
});

// Basic health
server.addTool({
  name: "health",
  description: "Health check for this MCP server.",
  execute: async () => asTextResponse({ status: "ok" }),
});

// UniFi: List Hosts
server.addTool({
  name: "unifi_list_hosts",
  description: "List UniFi hosts accessible to this API key (GET /v1/hosts).",
  execute: async () => asTextResponse(await unifiFetch("GET", "/v1/hosts")),
});

// UniFi: Get Host by ID
server.addTool({
  name: "unifi_get_host",
  description: "Get a UniFi host by id (GET /v1/hosts/{id}).",
  parameters: z.object({
    id: z.string().min(1).describe("Host ID"),
  }),
  execute: async ({ id }) => asTextResponse(await unifiFetch("GET", `/v1/hosts/${encodeURIComponent(id)}`)),
});

// UniFi: List Sites
server.addTool({
  name: "unifi_list_sites",
  description: "List UniFi sites accessible to this API key (GET /v1/sites).",
  execute: async () => asTextResponse(await unifiFetch("GET", "/v1/sites")),
});

// UniFi: List Devices
server.addTool({
  name: "unifi_list_devices",
  description: "List UniFi devices accessible to this API key (GET /v1/devices).",
  execute: async () => asTextResponse(await unifiFetch("GET", "/v1/devices")),
});

// Generic request
server.addTool({
  name: "unifi_request",
  description:
    "Make a UniFi Site Manager API request. Provide a path like '/v1/sites' or '/v1/hosts'. If you omit the version prefix, it will be prefixed with the configured UNIFI_API_VERSION (default: v1).",
  parameters: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    path: z.string().min(1).describe("Request path, e.g. /v1/sites or /v1/hosts"),
    query: z.record(z.any()).optional().describe("Optional query parameters object"),
    body: z.any().optional().describe("Optional JSON body (ignored for GET/HEAD)"),
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
