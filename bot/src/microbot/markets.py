import asyncio
import json
import math
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

GAMMA_HOST = "https://gamma-api.polymarket.com"
BINANCE_HOST = "https://api.binance.com"


@dataclass(frozen=True, slots=True)
class Market:
    """A binary market; YES is the first outcome (e.g. "Up"), NO the second."""

    slug: str
    question: str
    yes_token_id: str
    no_token_id: str
    end_ts: float = math.inf
    condition_id: str = ""
    start_ts: float | None = None
    tick_size: float | None = None
    min_order_size: float | None = None
    resolution_source: str = ""
    description: str = ""
    # Taker fee from Gamma's feeSchedule: size * rate * (p * (1 - p)) ** exponent.
    fee_rate: float | None = None
    fee_exponent: float = 1.0

    def outcome(self, token_id: str) -> str:
        return "YES" if token_id == self.yes_token_id else "NO"

    def as_dict(self) -> dict:
        row = asdict(self)
        row["end_ts"] = None if math.isinf(self.end_ts) else self.end_ts
        return row


@dataclass(frozen=True, slots=True)
class Resolution:
    payout_yes: float
    payout_no: float

    @property
    def winner(self) -> str:
        return "YES" if self.payout_yes > self.payout_no else "NO"

    def payout(self, outcome: str) -> float:
        return self.payout_yes if outcome == "YES" else self.payout_no


def _parse_ts(value: str | None) -> float | None:
    if not value:
        return None
    return datetime.fromisoformat(value).timestamp()


def _float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def market_from_gamma(m: dict, event: dict | None = None) -> Market | None:
    tokens = json.loads(m.get("clobTokenIds") or "[]")
    end = _parse_ts(m.get("endDate"))
    if len(tokens) != 2 or end is None:
        return None
    event = event or {}
    start = _parse_ts(m.get("eventStartTime") or event.get("startTime") or m.get("startDate"))
    schedule = m.get("feeSchedule") or {}
    fee_rate = None
    if m.get("feesEnabled") is False:
        fee_rate = 0.0
    elif _float(schedule.get("rate")) is not None:
        fee_rate = _float(schedule["rate"])
    return Market(
        m["slug"], m.get("question", ""), tokens[0], tokens[1], end,
        condition_id=m.get("conditionId", ""),
        start_ts=start,
        tick_size=_float(m.get("orderPriceMinTickSize")),
        min_order_size=_float(m.get("orderMinSize")),
        resolution_source=m.get("resolutionSource") or event.get("resolutionSource") or "",
        description=m.get("description") or event.get("description") or "",
        fee_rate=fee_rate,
        fee_exponent=_float(schedule.get("exponent")) or 1.0,
    )


def pick_market(events: list[dict], after: float) -> Market | None:
    """The market ending soonest after `after` that still accepts orders."""
    candidates = []
    for event in events:
        for m in event.get("markets", []):
            end = _parse_ts(m.get("endDate"))
            if end is None or end <= after or m.get("closed") or not m.get("acceptingOrders"):
                continue
            market = market_from_gamma(m, event)
            if market:
                candidates.append(market)
    return min(candidates, key=lambda c: c.end_ts, default=None)


def parse_resolution(m: dict) -> Resolution | None:
    """Official payouts once Gamma reports the market closed with prices settled at 0/1."""
    if not m.get("closed"):
        return None
    status = m.get("umaResolutionStatus")
    if status and status != "resolved":
        return None
    try:
        prices = [float(p) for p in json.loads(m.get("outcomePrices") or "[]")]
    except (TypeError, ValueError):
        return None
    if len(prices) != 2 or sorted(prices) != [0.0, 1.0]:
        return None
    return Resolution(prices[0], prices[1])


def _get_json(url: str):
    request = Request(url, headers={"User-Agent": "polymarket-microbot"})
    with urlopen(request, timeout=10) as response:
        return json.load(response)


async def find_series_market(series_slug: str, after: float) -> Market | None:
    """Current market of a rolling series such as `btc-up-or-down-15m`."""
    query = urlencode({
        "series_slug": series_slug, "active": "true", "closed": "false", "order": "endDate",
        "ascending": "true", "limit": 10,
        "end_date_min": datetime.fromtimestamp(after, UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    events = await asyncio.to_thread(_get_json, f"{GAMMA_HOST}/events?{query}")
    return pick_market(events, after)


async def fetch_gamma_market(slug: str) -> dict | None:
    """The market with `slug` plus its event under "events" (open or closed).

    `/markets?slug=` hides closed markets unless asked, so go through the event instead.
    """
    events = await asyncio.to_thread(_get_json, f"{GAMMA_HOST}/events?slug={quote(slug)}")
    for event in events or []:
        for m in event.get("markets", []):
            if m.get("slug") == slug:
                return m | {"events": [{k: v for k, v in event.items() if k != "markets"}]}
    return None


async def fetch_fee_rate_bps(clob_host: str, token_id: str) -> float | None:
    """Base taker fee in basis points for `token_id`, or None when the lookup fails."""
    try:
        data = await asyncio.to_thread(_get_json, f"{clob_host}/fee-rate?token_id={quote(token_id)}")
    except (OSError, ValueError, HTTPError):
        return None
    return _float(data.get("base_fee")) if isinstance(data, dict) else None


def event_btc_prices(m: dict) -> tuple[float | None, float | None]:
    """Reference prices Gamma publishes for crypto up/down events, when present."""
    for event in m.get("events") or []:
        meta = event.get("eventMetadata") or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except ValueError:
                meta = {}
        start, end = _float(meta.get("priceToBeat")), _float(meta.get("finalPrice"))
        if start is not None or end is not None:
            return start, end
    return None, None


def binance_price(ts: float, symbol: str = "BTCUSDT") -> float | None:
    """Open price of the 1-second Binance kline starting at `ts`."""
    start = int(ts * 1000)
    query = urlencode({"symbol": symbol, "interval": "1s", "startTime": start, "limit": 1})
    try:
        rows = _get_json(f"{BINANCE_HOST}/api/v3/klines?{query}")
    except (OSError, ValueError, HTTPError):
        return None
    return float(rows[0][1]) if rows else None


async def btc_prices(m: dict, start_ts: float | None, end_ts: float | None) -> dict:
    start, end = event_btc_prices(m)
    if start is not None and end is not None:
        return {"btc_open": start, "btc_close": end, "btc_source": "gamma"}
    if start_ts is None or end_ts is None:
        return {}
    opened = start if start is not None else await asyncio.to_thread(binance_price, start_ts)
    closed = end if end is not None else await asyncio.to_thread(binance_price, end_ts)
    return {"btc_open": opened, "btc_close": closed, "btc_source": "binance:BTCUSDT-1s"}
