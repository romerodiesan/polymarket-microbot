import logging
from collections.abc import Awaitable, Callable
from time import time

from .broker import Broker, Fill
from .markets import btc_prices, fetch_gamma_market, parse_resolution
from .storage import Storage

log = logging.getLogger(__name__)

FetchMarket = Callable[[str], Awaitable[dict | None]]
FetchPrices = Callable[[dict, float | None, float | None], Awaitable[dict]]
OnSettle = Callable[[Fill, dict], None]


class Resolver:
    """Waits for the official 0/1 payout of every traded market and settles what is still held."""

    def __init__(self, storage: Storage, broker: Broker, on_settle: OnSettle,
                 fetch_market: FetchMarket = fetch_gamma_market,
                 fetch_prices: FetchPrices = btc_prices) -> None:
        self.storage = storage
        self.broker = broker
        self.on_settle = on_settle
        self.fetch_market = fetch_market
        self.fetch_prices = fetch_prices

    def pending(self, now: float) -> list[dict]:
        return self.storage.query(
            "SELECT * FROM markets WHERE coalesce(resolved, false) = false "
            "AND end_ts IS NOT NULL AND end_ts <= ? ORDER BY end_ts", [now],
        )

    async def poll(self, now: float | None = None) -> int:
        """Resolve every ended market that Gamma reports settled; returns how many resolved."""
        resolved = 0
        for market in self.pending(now or time()):
            try:
                if await self.resolve(market):
                    resolved += 1
            except (OSError, ValueError) as exc:
                log.warning("Could not resolve %s (%s)", market["slug"], exc)
        return resolved

    async def resolve(self, market: dict) -> bool:
        data = await self.fetch_market(market["slug"])
        resolution = parse_resolution(data) if data else None
        if resolution is None:
            return False
        now = time()
        row = {
            "slug": market["slug"], "resolved": True, "winner": resolution.winner,
            "payout_yes": resolution.payout_yes, "payout_no": resolution.payout_no,
            "resolved_ts": now,
        }
        if market["slug"].startswith("btc"):
            row |= await self.fetch_prices(data, market.get("start_ts"), market.get("end_ts"))
        self.storage.upsert("markets", row)
        log.info("Resolved %s: %s", market["slug"], resolution.winner)
        for token, outcome in ((market["yes_token_id"], "YES"), (market["no_token_id"], "NO")):
            fill = self.broker.settle(token, resolution.payout(outcome), now,
                                      f"settle-{market['slug']}-{outcome}")
            if fill:
                self.on_settle(fill, {"market": market["slug"], "outcome": outcome})
        return True
