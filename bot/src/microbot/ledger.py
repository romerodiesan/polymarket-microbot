from dataclasses import dataclass

from .broker import Fill
from .positions import Position


@dataclass(slots=True)
class Mark:
    mid: float | None
    bid: float | None


class Ledger:
    """Cash, equity and risk computed from fills, independent of the broker's own bookkeeping.

    Equity marks open positions at the midpoint; `positions_value_bid` is what selling at the
    best bid would raise. Exposure is the cost basis of open positions.
    """

    def __init__(self, starting_cash: float) -> None:
        self.starting_cash = starting_cash
        self.cash = starting_cash
        self.realized_pnl = 0.0
        self.fees_paid = 0.0
        self.peak = starting_cash
        self.max_simultaneous_exposure = 0.0
        self.max_market_exposure = 0.0

    def on_fill(self, fill: Fill) -> None:
        notional = fill.size * fill.price
        self.cash += -(notional + fill.fee) if fill.side == "BUY" else notional - fill.fee
        self.fees_paid += fill.fee
        self.realized_pnl += fill.pnl

    def snapshot(self, ts: float, positions: dict[str, Position], marks: dict[str, Mark],
                 tags: dict[str, dict], locked: float = 0.0) -> tuple[dict, list[dict]]:
        """Equity row plus one row per open position."""
        value_mid = value_bid = unrealized = gross = 0.0
        per_market: dict[str, float] = {}
        rows = []
        for token, pos in positions.items():
            if not pos.open:
                continue
            mark = marks.get(token, Mark(None, None))
            mid = mark.mid if mark.mid is not None else pos.avg_price
            bid = mark.bid if mark.bid is not None else 0.0
            cost = pos.size * pos.avg_price
            value_mid += pos.size * mid
            value_bid += pos.size * bid
            unrealized += pos.size * mid - cost
            gross += cost
            tag = tags.get(token, {})
            market = tag.get("market") or token
            per_market[market] = per_market.get(market, 0.0) + cost
            rows.append({
                "ts": ts, "market": tag.get("market"), "token_id": token,
                "outcome": tag.get("outcome"), "size": pos.size, "avg_price": pos.avg_price,
                "mark_mid": mark.mid, "mark_bid": mark.bid, "unrealized": pos.size * mid - cost,
                "opened_at": pos.opened_at,
            })
        equity = self.cash + value_mid
        self.peak = max(self.peak, equity)
        self.max_simultaneous_exposure = max(self.max_simultaneous_exposure, gross + locked)
        self.max_market_exposure = max([self.max_market_exposure, *per_market.values()])
        row = {
            "ts": ts, "starting_cash": self.starting_cash, "cash": self.cash,
            "positions_value_mid": value_mid, "positions_value_bid": value_bid,
            "realized_pnl": self.realized_pnl, "unrealized_pnl": unrealized,
            "fees_paid": self.fees_paid, "equity": equity, "peak": self.peak,
            "drawdown": self.peak - equity, "gross_exposure": gross,
            "max_market_exposure": self.max_market_exposure,
            "max_simultaneous_exposure": self.max_simultaneous_exposure,
            "locked_in_orders": locked, "open_positions": len(rows),
        }
        return row, rows
