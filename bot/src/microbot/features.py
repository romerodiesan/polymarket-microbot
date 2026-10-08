from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from time import time
from typing import TYPE_CHECKING

from .book import OrderBook, TopOfBook

if TYPE_CHECKING:
    from .config import Settings


@dataclass(slots=True)
class FeatureRow:
    ts: float
    token_id: str
    best_bid: float
    best_ask: float
    midpoint: float
    spread: float
    bid_depth_3: float
    ask_depth_3: float
    book_imbalance: float
    microprice: float
    microprice_delta: float
    flow_imbalance: float
    trade_pressure: float
    score: float
    weighted_imbalance: float = 0.0
    ofi: float = 0.0
    volatility: float = 0.0
    spread_ticks: float = 0.0
    top_bid_size: float = 0.0
    top_ask_size: float = 0.0
    # Shares traded since the previous row; for charts, not a model feature.
    trade_volume: float = 0.0

    def as_dict(self) -> dict:
        return asdict(self)


class DecayingSum:
    """Sum of past contributions, each decaying by half every `half_life` seconds."""

    def __init__(self, half_life: float) -> None:
        self.half_life = half_life
        self.value = 0.0
        self.t: float | None = None

    def _decay(self, t: float) -> None:
        if self.t is not None and t > self.t:
            self.value *= 0.5 ** ((t - self.t) / self.half_life)
        self.t = t if self.t is None else max(self.t, t)

    def add(self, x: float, t: float) -> None:
        self._decay(t)
        self.value += x

    def read(self, t: float) -> float:
        self._decay(t)
        return self.value


class RunningZScore:
    """Time-weighted EWMA mean/variance; returns 0 until `warmup` samples were seen."""

    def __init__(self, half_life: float, warmup: int) -> None:
        self.half_life = half_life
        self.warmup = warmup
        self.mean = 0.0
        self.var = 0.0
        self.n = 0
        self.t = 0.0

    def update(self, x: float, t: float) -> float:
        if self.n == 0:
            self.mean, self.n, self.t = x, 1, t
            return 0.0
        std = math.sqrt(self.var)
        z = (x - self.mean) / std if std > 1e-12 else 0.0
        alpha = 1 - 0.5 ** (max(t - self.t, 1e-3) / self.half_life)
        diff = x - self.mean
        self.mean += alpha * diff
        self.var = (1 - alpha) * (self.var + alpha * diff * diff)
        self.n += 1
        self.t = t
        return max(-4.0, min(4.0, z)) if self.n > self.warmup else 0.0


@dataclass
class _TokenState:
    ofi: DecayingSum
    pressure: DecayingSum
    zscores: dict[str, RunningZScore]
    prev_bid_depth: float | None = None
    prev_ask_depth: float | None = None
    prev_mid: float | None = None
    prev_ts: float | None = None
    vol_var: float = 0.0
    traded: float = 0.0


SCORE_COMPONENTS = ("weighted_imbalance", "ofi", "trade_pressure", "microprice_delta")


def order_flow_imbalance(prev: TopOfBook, new: TopOfBook) -> float:
    """Cont–Kukanov–Stoikov OFI contribution of one top-of-book change."""
    if None in (prev.bid, prev.ask, new.bid, new.ask):
        return 0.0
    bid_flow = (new.bid_size if new.bid >= prev.bid else 0.0) - (
        prev.bid_size if new.bid <= prev.bid else 0.0)
    ask_flow = (new.ask_size if new.ask <= prev.ask else 0.0) - (
        prev.ask_size if new.ask >= prev.ask else 0.0)
    return bid_flow - ask_flow


class FeatureEngine:
    def __init__(self, settings: Settings | None = None) -> None:
        self.half_life = settings.signal_half_life_seconds if settings else 5.0
        self.z_half_life = settings.zscore_half_life_seconds if settings else 900.0
        self.warmup = settings.zscore_warmup_samples if settings else 30
        self.weights = {
            "weighted_imbalance": settings.weight_imbalance if settings else 0.35,
            "ofi": settings.weight_ofi if settings else 0.30,
            "trade_pressure": settings.weight_pressure if settings else 0.20,
            "microprice_delta": settings.weight_microprice if settings else 0.15,
        }
        self.state: dict[str, _TokenState] = {}

    def _token(self, token_id: str) -> _TokenState:
        if token_id not in self.state:
            self.state[token_id] = _TokenState(
                ofi=DecayingSum(self.half_life),
                pressure=DecayingSum(self.half_life),
                zscores={c: RunningZScore(self.z_half_life, self.warmup) for c in SCORE_COMPONENTS},
            )
        return self.state[token_id]

    def on_book_event(self, token_id: str, prev: TopOfBook, new: TopOfBook,
                      now: float | None = None) -> None:
        self._token(token_id).ofi.add(order_flow_imbalance(prev, new), now or time())

    def on_trade(self, token_id: str, side: str, size: float, now: float | None = None) -> None:
        signed = size if side.upper() == "BUY" else -size
        st = self._token(token_id)
        st.pressure.add(signed, now or time())
        st.traded += abs(size)

    def calculate(self, book: OrderBook, now: float | None = None) -> FeatureRow | None:
        now = now or time()
        bid, ask = book.best_bid, book.best_ask
        if bid is None or ask is None or ask <= bid:
            return None
        st = self._token(book.token_id)

        bid_depth, ask_depth = book.depth("bid"), book.depth("ask")
        total_depth = bid_depth + ask_depth
        imbalance = (bid_depth - ask_depth) / total_depth if total_depth else 0.0
        w_bid, w_ask = book.weighted_depth("bid"), book.weighted_depth("ask")
        weighted_imbalance = (w_bid - w_ask) / (w_bid + w_ask) if w_bid + w_ask else 0.0

        top_bid, top_ask = book.top_size("bid"), book.top_size("ask")
        top_total = top_bid + top_ask
        midpoint = (bid + ask) / 2
        microprice = (ask * top_bid + bid * top_ask) / top_total if top_total else midpoint
        spread = ask - bid
        micro_delta = (microprice - midpoint) / max(spread, 1e-9)

        prev_bid = bid_depth if st.prev_bid_depth is None else st.prev_bid_depth
        prev_ask = ask_depth if st.prev_ask_depth is None else st.prev_ask_depth
        flow_scale = abs(bid_depth - prev_bid) + abs(ask_depth - prev_ask)
        flow = ((bid_depth - prev_bid) - (ask_depth - prev_ask)) / max(flow_scale, 1.0)
        st.prev_bid_depth, st.prev_ask_depth = bid_depth, ask_depth

        depth_scale = max(top_total, 1.0)
        ofi = st.ofi.read(now) / depth_scale
        pressure = math.tanh(st.pressure.read(now) / depth_scale)

        # Per-minute volatility of the midpoint, from an EWMA of squared changes per second.
        if st.prev_mid is not None and st.prev_ts is not None and now > st.prev_ts:
            dt = now - st.prev_ts
            alpha = 1 - 0.5 ** (dt / self.z_half_life)
            st.vol_var += alpha * ((midpoint - st.prev_mid) ** 2 / dt - st.vol_var)
        st.prev_mid, st.prev_ts = midpoint, now
        volatility = math.sqrt(max(st.vol_var, 0.0) * 60)

        values = {
            "weighted_imbalance": weighted_imbalance,
            "ofi": ofi,
            "trade_pressure": pressure,
            "microprice_delta": micro_delta,
        }
        raw = sum(self.weights[c] * st.zscores[c].update(v, now) for c, v in values.items())
        score = math.tanh(raw)
        traded, st.traded = st.traded, 0.0

        return FeatureRow(
            ts=now, token_id=book.token_id, best_bid=bid, best_ask=ask,
            midpoint=midpoint, spread=spread, bid_depth_3=bid_depth,
            ask_depth_3=ask_depth, book_imbalance=imbalance, microprice=microprice,
            microprice_delta=micro_delta, flow_imbalance=flow,
            trade_pressure=pressure, score=score,
            weighted_imbalance=weighted_imbalance, ofi=ofi, volatility=volatility,
            spread_ticks=spread / book.tick_size if book.tick_size else 0.0,
            top_bid_size=top_bid, top_ask_size=top_ask, trade_volume=traded,
        )


def combine_market(rows: dict[str, FeatureRow], yes_token: str, no_token: str) -> float:
    """Merge per-token scores into one market signal (positive favours YES).

    YES and NO trade as complements, so bullish NO pressure is bearish for YES.
    Rewrites each row's score with its side of the signal and returns it.
    """
    yes, no = rows.get(yes_token), rows.get(no_token)
    if yes and no:
        signal = (yes.score - no.score) / 2
    elif yes:
        signal = yes.score
    elif no:
        signal = -no.score
    else:
        return 0.0
    if yes:
        yes.score = signal
    if no:
        no.score = -signal
    return signal
