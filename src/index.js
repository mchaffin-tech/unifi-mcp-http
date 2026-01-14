// src/index.js
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---- MCP server (tools) ----
function buildMcpServer() {
  const server = new McpServer({
    name: "unifi-cloud-mcp",
    version: "0.1.0",
  });

  // Example tool (replace with your UniFi calls)
  server.tool(
    "health_check",
    {},
    async () => ({
      content: [{ type: "text", text: "ok" }],
    })
  );

  // Example tool with args
  server.tool(
    "echo",
    { text: z.string().describe("Text to echo") },
    async ({ text }) => ({ content: [{ type: "text", text }] })
  );

  return server;
}

// ---- Streamable HTTP session management ----
const transportsBySessionId = new Map(); // sessionId -> transport

function getSessionIdFromHeaders(headers) {
  // Node/Hono lowercases headers; spec header is "Mcp-Session-Id"
  return headers["mcp-session-id"] || headers["Mcp-Session-Id"] || headers["mcp-session-id".toLowerCase()];
}

function isInitializeRequest(jsonBody) {
  // MCP initialize is JSON-RPC with method "initialize"
  return jsonBody?.method === "initialize";
}

async function getOrCreateTransport(req, body) {
  const sessionId = getSessionIdFromHeaders(req.header());

  if (sessionId && transportsBySessionId.has(sessionId)) {
    return transportsBySessionId.get(sessionId);
  }

  // Only create a new transport on initialize
  if (!sessionId && isInitializeRequest(body)) {
    const server = buildMcpServer();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transportsBySessionId.set(id, transport);
      },
      onsessionclosed: (id) => {
        transportsBySessionId.delete(id);
      },
    });

    await server.connect(transport);
    return transport;
  }

  return null;
}

// ---- HTTP app ----
const app = new Hono();

app.all("/mcp", async (c) => {
  const method = c.req.method.toUpperCase();

  // Body is only present for POST
  const body = method === "POST" ? await c.req.json().catch(() => null) : null;

  const transport = await getOrCreateTransport(c.req, body);
  if (!transport) {
    return c.json(
      {
        error:
          "No active session. Send an MCP initialize request first (POST /mcp method=initialize), then reuse Mcp-Session-Id header.",
      },
      400
    );
  }

  // The SDK transport expects a Node-style req/res-ish adapter.
  // We’ll bridge Hono's Request/Response using the SDK's handleRequest().
  //
  // This pattern is used by Hono integrations for StreamableHTTPServerTransport. :contentReference[oaicite:4]{index=4}

  const nodeReq = {
    method,
    headers: c.req.header(),
  };

  const res = new WebFetchServerResponse();

  await transport.handleRequest(
    // @ts-expect-error minimal adapter (method/headers enough)
    nodeReq,
    res,
    body
  );

  return await res.fetchResponse;
});

// Minimal Response adapter to collect status/headers/body and return a fetch Response.
class WebFetchServerResponse extends EventTarget {
  statusCode = 200;
  statusMessage = "OK";
  #headers = new Map(); // name -> [values]
  chunks = [];
  #encoder = new TextEncoder();

  constructor() {
    super();
    this.fetchResponse = new Promise((resolve) => {
      this.addEventListener("finish", () => {
        const headers = new Headers();
        for (const [name, values] of this.#headers.entries()) {
          for (const v of values) headers.append(name, v);
        }
        const body = this.chunks.length ? Buffer.concat(this.chunks) : null;
        resolve(new Response(body, { status: this.statusCode, headers }));
      });
    });
  }

  setHeader(name, value) {
    this.#headers.set(name.toLowerCase(), Array.isArray(value) ? value : [String(value)]);
  }
  getHeader(name) {
    return this.#headers.get(name.toLowerCase())?.[0];
  }
  write(chunk) {
    if (typeof chunk === "string") this.chunks.push(Buffer.from(this.#encoder.encode(chunk)));
    else this.chunks.push(Buffer.from(chunk));
  }
  end(chunk) {
    if (chunk) this.write(chunk);
    this.dispatchEvent(new Event("finish"));
  }
}

const port = Number(process.env.MCP_SERVER_PORT || 3000);
serve({ fetch: app.fetch, port });
console.log(`MCP Streamable HTTP listening on http://0.0.0.0:${port}/mcp`);
