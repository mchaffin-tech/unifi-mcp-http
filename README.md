# UniFi Cloud MCP (HTTP Streaming) — Node.js

This project runs an MCP server over **HTTP streaming** (FastMCP `httpStream` transport), and exposes a small set of tools that call UniFi's **official Site Manager API**.

## Prerequisites
- A UniFi API key (UniFi Site Manager → API section → Create API key)
- Docker + Docker Compose

UniFi Site Manager API docs (official):
- Authentication uses `X-API-Key`
- Base URL examples use `https://api.ui.com`
- Example endpoints include `/v1/hosts`, `/v1/sites`, `/v1/devices`

## Run

1) Create `.env`:

```bash
UNIFI_API_KEY=your_api_key_here
# Optional:
# MCP_HTTP_PORT=3000
# MCP_SERVER_PORT=3000
# MCP_HTTP_ENDPOINT=/mcp
# UNIFI_API_BASE_URL=https://api.ui.com
# UNIFI_API_VERSION=v1
```

2) Start:

```bash
docker compose up -d --build
```

3) Your MCP server is available at:

- `http://localhost:3000/mcp` (default)

## Tools exposed
- `health` — simple health check
- `unifi_list_hosts` — GET `/v1/hosts`
- `unifi_get_host` — GET `/v1/hosts/{id}`
- `unifi_list_sites` — GET `/v1/sites`
- `unifi_list_devices` — GET `/v1/devices`
- `unifi_request` — generic request tool (GET/POST/PUT/DELETE) against the UniFi API base URL

## Notes
- The official Site Manager API is currently documented as read-only.
- If you set `UNIFI_API_VERSION=ea`, the generic tool will target `/ea/...` instead of `/v1/...` when you provide relative paths.
