from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict, dataclass, field
from time import time
from typing import Protocol
from uuid import uuid4

from .book import OrderBook, TopOfBook
from .config import Settings
from .positions import Position, PositionBook
from .strategy import Intent

log = logging.getLogger(__name__)

FEE_DECIMALS = 5


@dataclass(slots=True)
class Fill:
    ts: float
    token_id: str
    side: str
    size: float
    price: float
    fee: float
    order_id: str
    mode: str
    reason: str = ""
    pnl: float = 0.0
    liquidity: str = "taker"
    fee_rate: float = 0.0
    fee_source: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass(slots=True)
class OrderContext:
    """What the strategy knew when it decided; copied onto the order record."""

    signal_ts: float | None = None
    market: str = ""
    outcome: str = ""
    prediction_id: str = ""


@dataclass(slots=True)
class OrderRecord:
    order_id: str
    mode: str
    token_id: str
    side: str
    reason: str
    requested_size: float
    limit_price: float
    order_type: str = "FAK"
    market: str = ""
    outcome: str = ""
    prediction_id: str = ""
    signal_ts: float | None = None
    submit_ts: float | None = None
    ack_ts: float | None = None
    done_ts: float | None = None
    status: str = "submitted"
    reject_reason: str | None = None
    latency_ms: float | None = None
    filled_size: float = 0.0
    avg_price: float | None = None
    fee: float = 0.0
    fee_rate: float = 0.0
    fee_source: str = ""
    liquidity: str = "taker"
    slippage_vs_mid: float | None = None
    slippage_vs_touch: float | None = None
    decision_bid: float | None = None
    decision_ask: float | None = None
    decision_mid: float | None = None
    decision_top_size: float | None = None
    exec_bid: float | None = None
    exec_ask: float | None = None
    exec_mid: float | None = None
    exec_top_size: float | None = None
    queue_ahead: float | None = None
    queue_time_ms: float | None = None

    def as_dict(self) -> dict:
        return asdict(self)

    def snapshot(self, prefix: str, top: TopOfBook) -> None:
        mid = (top.bid + top.ask) / 2 if top.bid is not None and top.ask is not None else None
        size = top.ask_size if self.side == "BUY" else top.bid_size
        setattr(self, f"{prefix}_bid", top.bid)
        setattr(self, f"{prefix}_ask", top.ask)
        setattr(self, f"{prefix}_mid", mid)
        setattr(self, f"{prefix}_top_size", size)

    def finish(self, filled: float, price: float | None, fee: float, now: float) -> None:
        self.filled_size, self.avg_price, self.fee, self.done_ts = filled, price, fee, now
        if filled <= 0:
            self.status = "rejected"
            return
        self.status = "filled" if filled >= self.requested_size - 1e-9 else "partial"
        sign = 1 if self.side == "BUY" else -1
        if price is not None and self.decision_mid is not None:
            self.slippage_vs_mid = sign * (price - self.decision_mid)
        touch = self.decision_ask if self.side == "BUY" else self.decision_bid
        if price is not None and touch is not None:
            self.slippage_vs_touch = sign * (price - touch)


@dataclass(slots=True)
class Execution:
    order: OrderRecord
    fill: Fill | None


class Broker(Protocol):
    book: PositionBook

    async def submit(self, intent: Intent, order_book: OrderBook,
                     context: OrderContext | None = None) -> Execution: ...

    def position(self, token_id: str) -> float: ...

    def positions(self) -> dict[str, Position]: ...

    def settle(self, token_id: str, payout: float, ts: float, order_id: str) -> Fill | None: ...


def polymarket_fee(fee_rate: float, size: float, price: float, exponent: float = 1.0) -> float:
    """Taker fee in USDC: shares * rate * (p * (1 - p)) ** exponent, rounded like the exchange."""
    return round(size * fee_rate * (price * (1 - price)) ** exponent, FEE_DECIMALS)


def venue_fee(trades: list[dict], rate: float, exponent: float, source: str) -> tuple[float, str]:
    """Taker fee of the trades the venue matched, each at its own price.

    The CLOB reports the rate it applied (`fee_rate_bps`) but not the amount: trades it marks
    with 0 bps paid nothing, the others pay the market's schedule on their own price and size.
    """
    fee = 0.0
    charged = 0
    for trade in trades:
        bps = trade.get("fee_rate_bps")
        if bps is not None and float(bps) == 0:
            continue
        charged += 1
        fee += polymarket_fee(rate, float(trade["size"]), float(trade["price"]), exponent)
    if not charged:
        return 0.0, "venue:fee_rate_bps=0"
    return round(fee, FEE_DECIMALS), f"venue:{len(trades)} trades ({source})"


@dataclass(slots=True)
class FeeSchedule:
    """Fee rate (and exponent) per token; tokens without an entry use the configured default."""

    default_rate: float
    rates: dict[str, tuple[float, str, float]] = field(default_factory=dict)

    def set(self, token_id: str, rate: float, source: str, exponent: float = 1.0) -> None:
        self.rates[token_id] = (rate, source, exponent)

    def get(self, token_id: str) -> tuple[float, str, float]:
        return self.rates.get(token_id, (self.default_rate, "config", 1.0))


def take(book: OrderBook, side: str, size: float, limit: float, *, cash: float, held: float,
         fee_rate: float, haircut: float = 1.0, shift: float = 0.0, fee_exponent: float = 1.0
         ) -> tuple[float, float, float, str | None]:
    """Execute a FAK taker order against `book`: (filled, price, fee, reject_reason)."""
    if side == "SELL":
        size = min(size, held)
        if size <= 0:
            return 0.0, 0.0, 0.0, "no_position"
    filled, price = book.walk(side, size, limit, haircut, shift)
    if filled <= 0:
        return 0.0, 0.0, 0.0, "no_liquidity_within_limit"
    fee = polymarket_fee(fee_rate, filled, price, fee_exponent)
    if side == "BUY" and filled * price + fee > cash:
        per_share = price + fee_rate * (price * (1 - price)) ** fee_exponent
        filled = int(min(filled, cash / per_share) * 100) / 100
        if filled <= 0:
            return 0.0, 0.0, 0.0, "insufficient_cash"
        fee = polymarket_fee(fee_rate, filled, price, fee_exponent)
    return filled, price, fee, None


class PaperBroker:
    """Simulates FAK taker orders that reach the book after the configured latency."""

    def __init__(self, settings: Settings) -> None:
        self.s = settings
        self.cash = settings.paper_starting_cash
        self.book = PositionBook()
        self.fees = FeeSchedule(settings.fee_rate)
        # Measured REST round trip; used when PM_PAPER_LATENCY_MS is unset.
        self.rtt_ms = 0.0

    @property
    def latency_ms(self) -> float:
        return self.s.paper_latency_ms if self.s.paper_latency_ms is not None else self.rtt_ms

    def position(self, token_id: str) -> float:
        return self.book.size(token_id)

    def positions(self) -> dict[str, Position]:
        return self.book.positions

    async def submit(self, intent: Intent, order_book: OrderBook,
                     context: OrderContext | None = None) -> Execution:
        context = context or OrderContext()
        order = new_order("paper", intent, context)
        order.snapshot("decision", order_book.top())
        latency = self.latency_ms
        if latency > 0:
            # The book keeps updating while the order is in flight.
            await asyncio.sleep(latency / 1000)
        now = time()
        order.ack_ts, order.latency_ms = now, latency
        order.snapshot("exec", order_book.top())
        rate, source, exponent = self.fees.get(intent.token_id)
        order.fee_rate, order.fee_source = rate, source
        filled, price, fee, reject = take(
            order_book, intent.side, intent.size, intent.limit_price,
            cash=self.cash, held=self.position(intent.token_id), fee_rate=rate,
            haircut=self.s.paper_fill_haircut,
            shift=self.s.paper_extra_slippage_ticks * order_book.tick_size,
            fee_exponent=exponent,
        )
        order.finish(filled, price if filled else None, fee, now)
        if reject:
            order.reject_reason = reject
            return Execution(order, None)
        pnl = self.book.apply(intent.token_id, intent.side, filled, price, fee, now)
        self.cash += -(filled * price + fee) if intent.side == "BUY" else filled * price - fee
        fill = Fill(now, intent.token_id, intent.side, filled, price, fee, order.order_id,
                    "paper", intent.reason, pnl, "taker", rate, source)
        return Execution(order, fill)

    def settle(self, token_id: str, payout: float, ts: float, order_id: str) -> Fill | None:
        size = self.position(token_id)
        if size <= 0:
            return None
        pnl = self.book.apply(token_id, "SELL", size, payout, 0.0, ts)
        self.cash += size * payout
        return Fill(ts, token_id, "SELL", size, payout, 0.0, order_id, "paper", "settlement",
                    pnl, "settlement", 0.0, "none")


def new_order(mode: str, intent: Intent, context: OrderContext) -> OrderRecord:
    return OrderRecord(
        order_id=f"{mode}-{uuid4().hex[:16]}", mode=mode, token_id=intent.token_id,
        side=intent.side, reason=intent.reason, requested_size=intent.size,
        limit_price=intent.limit_price, market=context.market, outcome=context.outcome,
        prediction_id=context.prediction_id, signal_ts=context.signal_ts, submit_ts=time(),
    )


class LiveBroker:
    def __init__(self, settings: Settings) -> None:
        try:
            from py_clob_client.client import ClobClient
        except ImportError as exc:
            raise RuntimeError("Install live dependencies: pip install -e '.[live]'") from exc
        self.s = settings
        self.book = PositionBook()
        self.fees = FeeSchedule(settings.fee_rate)
        self.rtt_ms = 0.0
        self.client = ClobClient(
            settings.clob_host, key=settings.private_key, chain_id=settings.chain_id,
            signature_type=settings.signature_type, funder=settings.funder,
        )
        if settings.api_key and settings.api_secret and settings.api_passphrase:
            from py_clob_client.clob_types import ApiCreds
            self.client.set_api_creds(ApiCreds(settings.api_key, settings.api_secret,
                                               settings.api_passphrase))
        else:
            self.client.set_api_creds(self.client.create_or_derive_api_creds())

    def position(self, token_id: str) -> float:
        return self.book.size(token_id)

    def positions(self) -> dict[str, Position]:
        return self.book.positions

    async def submit(self, intent: Intent, order_book: OrderBook,
                     context: OrderContext | None = None) -> Execution:
        from asyncio import to_thread

        from py_clob_client.clob_types import OrderArgs, OrderType
        from py_clob_client.constants import BUY, SELL

        order = new_order("live", intent, context or OrderContext())
        order.snapshot("decision", order_book.top())
        side = BUY if intent.side == "BUY" else SELL
        args = OrderArgs(token_id=intent.token_id, size=intent.size, side=side,
                         price=intent.limit_price)
        try:
            signed = await to_thread(self.client.create_order, args)
            result = await to_thread(self.client.post_order, signed, OrderType.FAK)
        except Exception as exc:  # noqa: BLE001 - the venue reports errors as exceptions
            order.finish(0.0, None, 0.0, time())
            order.reject_reason = f"error: {exc}"[:200]
            return Execution(order, None)
        now = time()
        order.ack_ts = now
        order.latency_ms = (now - order.submit_ts) * 1000
        order.snapshot("exec", order_book.top())
        if not result or not result.get("success", False):
            order.finish(0.0, None, 0.0, now)
            order.reject_reason = str((result or {}).get("errorMsg") or "rejected")[:200]
            return Execution(order, None)
        venue_id = str(result.get("orderID", ""))
        if venue_id:
            order.order_id = venue_id
        filled, price, trades = await self.reconcile(venue_id, intent)
        rate, source, exponent = self.fees.get(intent.token_id)
        if filled and trades:
            fee, order.fee_source = venue_fee(trades, rate, exponent, source)
        else:
            fee = polymarket_fee(rate, filled, price, exponent) if filled else 0.0
            order.fee_source = f"{source}:estimated"
        order.fee_rate = rate
        order.finish(filled, price if filled else None, fee, time())
        if filled <= 0:
            order.reject_reason = "no_match"
            return Execution(order, None)
        pnl = self.book.apply(intent.token_id, intent.side, filled, price, fee, now)
        fill = Fill(now, intent.token_id, intent.side, filled, price, fee, order.order_id,
                    "live", intent.reason, pnl, "taker", rate, order.fee_source)
        return Execution(order, fill)

    async def reconcile(self, venue_id: str, intent: Intent) -> tuple[float, float, list[dict]]:
        """Matched size, average price and the venue's trades for a FAK order.

        The trades list is empty when they could not be read; the fee is then estimated.
        """
        from asyncio import to_thread

        try:
            data = await to_thread(self.client.get_order, venue_id) if venue_id else None
        except Exception as exc:  # noqa: BLE001
            log.warning("Could not reconcile order %s (%s); booking the limit", venue_id, exc)
            data = None
        if not data:
            return intent.size, intent.limit_price, []
        filled = float(data.get("size_matched") or 0)
        price = float(data.get("price") or intent.limit_price)
        trade_ids = data.get("associate_trades") or []
        trades: list[dict] = []
        if filled and trade_ids:
            try:
                from py_clob_client.clob_types import TradeParams

                for trade_id in trade_ids:
                    trades.extend(await to_thread(self.client.get_trades, TradeParams(id=trade_id)))
                size = sum(float(t["size"]) for t in trades)
                if size:
                    price = sum(float(t["size"]) * float(t["price"]) for t in trades) / size
            except Exception as exc:  # noqa: BLE001
                log.warning("Could not read trades of %s (%s)", venue_id, exc)
                trades = []
        return filled, price, trades

    def settle(self, token_id: str, payout: float, ts: float, order_id: str) -> Fill | None:
        size = self.position(token_id)
        if size <= 0:
            return None
        pnl = self.book.apply(token_id, "SELL", size, payout, 0.0, ts)
        return Fill(ts, token_id, "SELL", size, payout, 0.0, order_id, "live", "settlement",
                    pnl, "settlement", 0.0, "none")
