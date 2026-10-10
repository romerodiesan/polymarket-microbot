import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable

import websockets

log = logging.getLogger(__name__)

# on_status(kind, connection_id, detail) with kind "connect" or "disconnect".
StatusCallback = Callable[[str, int, str], None]


class MarketStream:
    def __init__(self, url: str, token_ids: list[str],
                 on_status: StatusCallback | None = None) -> None:
        self.url = url
        self.token_ids = token_ids
        self.on_status = on_status or (lambda kind, connection, detail: None)
        self.connection_id = 0

    async def events(self) -> AsyncIterator[dict]:
        delay = 1
        while True:
            try:
                async with websockets.connect(self.url, ping_interval=None, max_size=4_000_000) as ws:
                    await ws.send(json.dumps({"type": "market", "assets_ids": self.token_ids,
                                              "custom_feature_enabled": True}))
                    self.connection_id += 1
                    self.on_status("connect", self.connection_id, "")
                    heartbeat = asyncio.create_task(self._heartbeat(ws))
                    delay = 1
                    try:
                        async for raw in ws:
                            if raw == "PONG":
                                continue
                            payload = json.loads(raw)
                            for event in payload if isinstance(payload, list) else [payload]:
                                yield event
                    finally:
                        heartbeat.cancel()
                self.on_status("disconnect", self.connection_id, "closed")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - any failure means reconnect
                self.on_status("disconnect", self.connection_id, str(exc)[:200])
                log.warning("WebSocket disconnected (%s); retrying in %ss", exc, delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)

    @staticmethod
    async def _heartbeat(ws) -> None:
        while True:
            await asyncio.sleep(10)
            await ws.send("PING")
