import os
import httpx


class UniFiSiteManagerClient:
    """
    Official UniFi Site Manager API client.
    Auth: X-API-KEY header. Base: https://api.ui.com/v1
    """
    def __init__(self) -> None:
        api_key = os.getenv("UNIFI_API_KEY")
        if not api_key:
            raise RuntimeError("UNIFI_API_KEY is required")

        self.base_url = os.getenv("UNIFI_BASE_URL", "https://api.ui.com").rstrip("/")
        self.version = os.getenv("UNIFI_API_VERSION", "v1").strip("/")
        self.timeout_s = float(os.getenv("UNIFI_TIMEOUT", "30"))

        self._client = httpx.AsyncClient(
            base_url=f"{self.base_url}/{self.version}",
            headers={
                "X-API-KEY": api_key,          # required by official docs
                "Accept": "application/json",
            },
            timeout=self.timeout_s,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def list_hosts(self) -> dict:
        r = await self._client.get("/hosts")
        r.raise_for_status()
        return r.json()

    async def list_sites(self) -> dict:
        r = await self._client.get("/sites")
        r.raise_for_status()
        return r.json()

    async def list_devices(self, site_id: str) -> dict:
        r = await self._client.get("/devices", params={"siteId": site_id})
        r.raise_for_status()
        return r.json()

    async def get_isp_metrics(self, site_id: str) -> dict:
        r = await self._client.get("/isp-metrics", params={"siteId": site_id})
        r.raise_for_status()
        return r.json()
