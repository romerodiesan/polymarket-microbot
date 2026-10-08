from __future__ import annotations

from dataclasses import dataclass, field
from time import time
from typing import NamedTuple


class TopOfBook(NamedTuple):
    bid: float | None
    bid_size: float
    ask: float | None
    ask_size: float


@dataclass(slots=True)
class OrderBook:
    token_id: str
    bids: dict[float, float] = field(default_factory=dict)
    asks: dict[float, float] = field(default_factory=dict)
    updated_at: float = 0.0
    tick_size: float = 0.01
    _sorted_bids: list[float] | None = field(default=None, repr=False)
    _sorted_asks: list[float] | None = field(default=None, repr=False)

    def replace(self, bids: list[dict], asks: list[dict], timestamp_ms: str | int | None = None) -> None:
        self.bids = self._levels(bids)
        self.asks = self._levels(asks)
        self._sorted_bids = self._sorted_asks = None
        self.updated_at = self._timestamp(timestamp_ms)

    def update_level(self, side: str, price: str | float, size: str | float, timestamp_ms=None) -> None:
        is_bid = side.upper() == "BUY"
        levels = self.bids if is_bid else self.asks
        p, s = float(price), float(size)
        known = p in levels
        if s <= 0:
            levels.pop(p, None)
        else:
            levels[p] = s
        if known != (p in levels):
            if is_bid:
                self._sorted_bids = None
            else:
                self._sorted_asks = None
        self.updated_at = self._timestamp(timestamp_ms)

    def prices(self, side: str) -> list[float]:
        """Price levels for "bid" or "ask", best first."""
        if side == "bid":
            if self._sorted_bids is None:
                self._sorted_bids = sorted(self.bids, reverse=True)
            return self._sorted_bids
        if self._sorted_asks is None:
            self._sorted_asks = sorted(self.asks)
        return self._sorted_asks

    @property
    def best_bid(self) -> float | None:
        prices = self.prices("bid")
        return prices[0] if prices else None

    @property
    def best_ask(self) -> float | None:
        prices = self.prices("ask")
        return prices[0] if prices else None

    @property
    def spread(self) -> float | None:
        if self.best_bid is None or self.best_ask is None:
            return None
        return self.best_ask - self.best_bid

    @property
    def midpoint(self) -> float | None:
        if self.best_bid is None or self.best_ask is None:
            return None
        return (self.best_bid + self.best_ask) / 2

    def top(self) -> TopOfBook:
        return TopOfBook(self.best_bid, self.top_size("bid"), self.best_ask, self.top_size("ask"))

    def depth(self, side: str, levels: int = 3) -> float:
        data = self.bids if side == "bid" else self.asks
        return sum(data[p] for p in self.prices(side)[:levels])

    def weighted_depth(self, side: str, levels: int = 5, decay: float = 0.5) -> float:
        """Depth where level i (0 = best) counts with weight decay**i."""
        data = self.bids if side == "bid" else self.asks
        return sum(data[p] * decay**i for i, p in enumerate(self.prices(side)[:levels]))

    def top_size(self, side: str) -> float:
        prices = self.prices(side)
        data = self.bids if side == "bid" else self.asks
        return data[prices[0]] if prices else 0.0

    def walk(self, side: str, size: float, limit: float) -> tuple[float, float]:
        """Simulate a taker order of `size` for side "BUY"/"SELL" up to `limit`.

        Returns (filled_size, average_price); average_price is 0 when nothing fills.
        """
        buying = side.upper() == "BUY"
        book_side, data = ("ask", self.asks) if buying else ("bid", self.bids)
        remaining, notional = size, 0.0
        for price in self.prices(book_side):
            if (buying and price > limit) or (not buying and price < limit) or remaining <= 0:
                break
            take = min(remaining, data[price])
            remaining -= take
            notional += take * price
        filled = size - remaining
        return filled, (notional / filled if filled else 0.0)

    @staticmethod
    def _levels(items: list[dict]) -> dict[float, float]:
        return {float(x["price"]): float(x["size"]) for x in items if float(x["size"]) > 0}

    @staticmethod
    def _timestamp(timestamp_ms) -> float:
        return float(timestamp_ms) / 1000 if timestamp_ms else time()
