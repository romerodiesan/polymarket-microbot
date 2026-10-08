from __future__ import annotations

from dataclasses import asdict, dataclass
from time import time
from typing import Protocol

from .book import OrderBook
from .config import Settings
from .positions import Position, PositionBook
from .strategy import Intent


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

    def as_dict(self) -> dict:
        return asdict(self)


class Broker(Protocol):
    book: PositionBook

    async def submit(self, intent: Intent, order_book: OrderBook) -> Fill | None: ...

    def position(self, token_id: str) -> float: ...

    def positions(self) -> dict[str, Position]: ...


def polymarket_fee(settings: Settings, size: float, price: float) -> float:
    return size * settings.fee_rate * price * (1 - price)


class PaperBroker:
    """Simulates FAK taker orders against the current order book."""

    def __init__(self, settings: Settings) -> None:
        self.s = settings
        self.cash = settings.paper_starting_cash
        self.book = PositionBook()
        self.sequence = 0

    def position(self, token_id: str) -> float:
        return self.book.size(token_id)

    def positions(self) -> dict[str, Position]:
        return self.book.positions

    async def submit(self, intent: Intent, order_book: OrderBook) -> Fill | None:
        size = intent.size
        if intent.side == "SELL":
            size = min(size, self.position(intent.token_id))
        if size <= 0:
            return None
        filled, price = order_book.walk(intent.side, size, intent.limit_price)
        if filled <= 0:
            return None
        fee = polymarket_fee(self.s, filled, price)
        if intent.side == "BUY" and filled * price + fee > self.cash:
            affordable = self.cash / (price * (1 + self.s.fee_rate * (1 - price)))
            filled = round(min(filled, affordable), 2)
            if filled <= 0:
                return None
            fee = polymarket_fee(self.s, filled, price)
        now = time()
        pnl = self.book.apply(intent.token_id, intent.side, filled, price, fee, now)
        self.cash += -(filled * price + fee) if intent.side == "BUY" else filled * price - fee
        self.sequence += 1
        return Fill(now, intent.token_id, intent.side, filled, price, fee,
                    f"paper-{self.sequence}", "paper", intent.reason, pnl)


class LiveBroker:
    def __init__(self, settings: Settings) -> None:
        try:
            from py_clob_client.client import ClobClient
        except ImportError as exc:
            raise RuntimeError("Install live dependencies: pip install -e '.[live]'") from exc
        self.s = settings
        self.book = PositionBook()
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

    async def submit(self, intent: Intent, order_book: OrderBook) -> Fill | None:
        from asyncio import to_thread

        from py_clob_client.clob_types import OrderArgs, OrderType
        from py_clob_client.constants import BUY, SELL

        side = BUY if intent.side == "BUY" else SELL
        args = OrderArgs(token_id=intent.token_id, size=intent.size, side=side,
                         price=intent.limit_price)
        signed = await to_thread(self.client.create_order, args)
        result = await to_thread(self.client.post_order, signed, OrderType.FAK)
        if not result or not result.get("success", False):
            return None
        # The exchange may fill below the limit; book the limit as a conservative estimate and
        # reconcile with the venue before relying on these numbers.
        now = time()
        pnl = self.book.apply(intent.token_id, intent.side, intent.size, intent.limit_price, 0.0, now)
        return Fill(now, intent.token_id, intent.side, intent.size, intent.limit_price, 0.0,
                    str(result.get("orderID", "unknown")), "live", intent.reason, pnl)
