import os
from fastmcp import FastMCP
from .unifi_api import UniFiSiteManagerClient

mcp = FastMCP("UniFi Site Manager MCP")

# ---- Tools (Open WebUI will see these) ----

@mcp.tool()
async def health() -> dict:
    return {
        "status": "ok",
        "transport": "streamable-http",
        "base_url": os.getenv("UNIFI_BASE_URL", "https://api.ui.com"),
        "api_version": os.getenv("UNIFI_API_VERSION", "v1"),
    }

@mcp.tool()
async def list_hosts() -> dict:
    c = UniFiSiteManagerClient()
    try:
        return await c.list_hosts()
    finally:
        await c.close()

@mcp.tool()
async def list_sites() -> dict:
    c = UniFiSiteManagerClient()
    try:
        return await c.list_sites()
    finally:
        await c.close()

@mcp.tool()
async def list_devices(site_id: str) -> dict:
    c = UniFiSiteManagerClient()
    try:
        return await c.list_devices(site_id)
    finally:
        await c.close()

@mcp.tool()
async def get_isp_metrics(site_id: str) -> dict:
    c = UniFiSiteManagerClient()
    try:
        return await c.get_isp_metrics(site_id)
    finally:
        await c.close()

def main() -> None:
    port = int(os.getenv("MCP_PORT", "3000"))
    path = os.getenv("MCP_PATH", "/mcp")

    mcp.run(
        transport="streamable-http",
        host="0.0.0.0",
        port=port,
        path=path,
    )
