# UniFi Site Manager MCP (Streamable HTTP) — Node.js

This runs an MCP server over **HTTP streaming** (FastMCP `httpStream`) and implements tools for UniFi's **Site Manager API**.

## Configure

Create `.env`:

```env
UNIFI_API_KEY=your_key_here

# Optional
MCP_HTTP_PORT=3000
MCP_SERVER_PORT=3000
MCP_HTTP_ENDPOINT=/mcp
UNIFI_API_BASE_URL=https://api.ui.com
UNIFI_API_VERSION=v1
```

## Run

```bash
docker compose up -d --build
```

The MCP endpoint will be available at:

- `http://localhost:3000/mcp` (default)

## Tools implemented (from the Site Manager API docs)

- `unifi_list_hosts` (GET /v1/hosts) with pagination
- `unifi_get_host_by_id` (GET /v1/hosts/:id)
- `unifi_list_sites` (GET /v1/sites) with pagination
- `unifi_list_devices` (GET /v1/devices) with filters + pagination
- `unifi_get_isp_metrics` (GET /ea/isp-metrics/:type) with time range params
- `unifi_query_isp_metrics` (POST /ea/isp-metrics/:type/query)
- `unifi_list_sdwan_configs` (GET /ea/sd-wan-configs)
- `unifi_get_sdwan_config_by_id` (GET /ea/sd-wan-configs/:id)
- `unifi_get_sdwan_config_status` (GET /ea/sd-wan-configs/:id/status)

Plus a generic `unifi_request` tool for ad-hoc calls.

## Open WebUI
Add an MCP server of type **MCP (Streamable HTTP)** with URL:

- `http://host.docker.internal:3000/mcp` (if Open WebUI is in Docker on the same host)
- `http://localhost:3000/mcp` (if Open WebUI is running on the host)
