from dataclasses import dataclass

EPSILON = 1e-9


@dataclass(slots=True)
class Position:
    size: float = 0.0
    avg_price: float = 0.0
    opened_at: float = 0.0

    @property
    def open(self) -> bool:
        return self.size > EPSILON


class PositionBook:
    """Per-token inventory with average entry price and realized PnL."""

    def __init__(self) -> None:
        self.positions: dict[str, Position] = {}
        self.realized_pnl = 0.0

    def get(self, token_id: str) -> Position:
        return self.positions.get(token_id, Position())

    def size(self, token_id: str) -> float:
        return self.get(token_id).size

    def apply(self, token_id: str, side: str, size: float, price: float, fee: float,
              ts: float) -> float:
        """Record a fill and return the PnL it realizes (0 for buys)."""
        pos = self.positions.setdefault(token_id, Position())
        if side == "BUY":
            if not pos.open:
                pos.opened_at = ts
            cost = pos.avg_price * pos.size + price * size + fee
            pos.size += size
            pos.avg_price = cost / pos.size
            return 0.0
        size = min(size, pos.size)
        pnl = (price - pos.avg_price) * size - fee
        pos.size -= size
        if not pos.open:
            pos.size, pos.avg_price, pos.opened_at = 0.0, 0.0, 0.0
        self.realized_pnl += pnl
        return pnl
