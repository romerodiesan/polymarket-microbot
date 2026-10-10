import asyncio
from datetime import UTC, datetime

from microbot.markets import btc_prices, event_btc_prices, parse_resolution, pick_market


def ts(hhmm: str) -> float:
    return datetime.fromisoformat(f"2026-10-08T{hhmm}:00+00:00").astimezone(UTC).timestamp()


def market(slug: str, end: str, **overrides) -> dict:
    return {
        "slug": slug, "question": slug, "endDate": f"2026-10-08T{end}:00Z", "closed": False,
        "acceptingOrders": True, "clobTokenIds": f'["{slug}-up", "{slug}-down"]',
    } | overrides


def test_picks_the_open_market_ending_soonest():
    events = [{"markets": [market("late", "22:00")]}, {"markets": [market("now", "21:45")]}]
    picked = pick_market(events, after=ts("21:35"))
    assert (picked.slug, picked.yes_token_id, picked.no_token_id) == ("now", "now-up", "now-down")
    assert picked.end_ts == ts("21:45")
    assert picked.outcome("now-down") == "NO"


def test_skips_markets_ending_before_cutoff_or_not_tradable():
    events = [{"markets": [
        market("ending", "21:45"),
        market("closed", "21:50", closed=True),
        market("paused", "21:55", acceptingOrders=False),
        market("next", "22:00"),
    ]}]
    assert pick_market(events, after=ts("21:45")).slug == "next"
    assert pick_market([], after=ts("21:45")) is None


def test_market_metadata_comes_from_gamma():
    picked = pick_market([{"startTime": "2026-10-08T21:30:00Z", "markets": [market(
        "now", "21:45", conditionId="0xabc", orderPriceMinTickSize=0.01, orderMinSize=5,
        resolutionSource="https://data.chain.link/streams/btc-usd", description="Rules",
    )]}], after=ts("21:35"))
    assert picked.condition_id == "0xabc"
    assert picked.start_ts == ts("21:30")
    assert (picked.tick_size, picked.min_order_size) == (0.01, 5.0)
    assert picked.resolution_source.startswith("https://data.chain.link")
    assert picked.as_dict()["description"] == "Rules"


def test_fee_schedule_and_fetch_through_events(monkeypatch):
    m = market("now", "21:45", feesEnabled=True,
               feeSchedule={"exponent": 1, "rate": 0.07, "takerOnly": True})
    picked = pick_market([{"markets": [m]}], after=ts("21:35"))
    assert (picked.fee_rate, picked.fee_exponent) == (0.07, 1.0)
    free = pick_market([{"markets": [m | {"feesEnabled": False}]}], after=ts("21:35"))
    assert free.fee_rate == 0.0
    assert pick_market([{"markets": [market("x", "21:45")]}], after=ts("21:35")).fee_rate is None

    from microbot import markets as module
    event = {"slug": "now", "eventMetadata": {"priceToBeat": 1.0}, "markets": [m]}
    monkeypatch.setattr(module, "_get_json", lambda url: [event] if "events?slug=now" in url else [])
    found = asyncio.run(module.fetch_gamma_market("now"))
    assert found["slug"] == "now"
    assert found["events"] == [{"slug": "now", "eventMetadata": {"priceToBeat": 1.0}}]
    assert asyncio.run(module.fetch_gamma_market("missing")) is None


def test_resolution_requires_closed_market_with_settled_prices():
    resolved = market("m", "21:45", closed=True, outcomePrices='["0", "1"]',
                      umaResolutionStatus="resolved")
    r = parse_resolution(resolved)
    assert (r.payout_yes, r.payout_no, r.winner) == (0.0, 1.0, "NO")
    assert r.payout("NO") == 1.0
    assert parse_resolution(market("m", "21:45", outcomePrices='["0", "1"]')) is None
    assert parse_resolution(resolved | {"outcomePrices": '["0.6", "0.4"]'}) is None
    assert parse_resolution(resolved | {"umaResolutionStatus": "proposed"}) is None


def test_btc_prices_prefer_gamma_event_metadata():
    m = {"events": [{"eventMetadata": {"priceToBeat": 62000.5, "finalPrice": 62010}}]}
    assert event_btc_prices(m) == (62000.5, 62010.0)
    prices = asyncio.run(btc_prices(m, 0, 900))
    assert prices == {"btc_open": 62000.5, "btc_close": 62010.0, "btc_source": "gamma"}
    assert asyncio.run(btc_prices({}, None, None)) == {}
