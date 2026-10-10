import argparse
import asyncio
import json
import logging
import math
import signal
import subprocess
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from time import perf_counter, time
from urllib.request import Request, urlopen
from uuid import uuid4

from .book import OrderBook
from .broker import Execution, LiveBroker, OrderContext, PaperBroker
from .config import Settings
from .features import FeatureEngine, FeatureRow, combine_market
from .ledger import Ledger, Mark
from .markets import Market, fetch_fee_rate_bps, find_series_market
from .model import ModelPredictor, features_version
from .resolver import Resolver
from .storage import BOOK_EVENT_COLUMNS, PartitionedWriter, Storage
from .strategy import MIN_LIMIT_PRICE, Intent, MicrostructureStrategy
from .ws import MarketStream

SERIES_RETRY_SECONDS = 15
FULL_SNAPSHOT_SECONDS = 60
SECRETS = {"private_key", "api_key", "api_secret", "api_passphrase", "funder",
           "enable_live_trading"}


def git_commit() -> str | None:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=5,
            cwd=Path(__file__).parent, check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def package_version() -> str | None:
    try:
        return version("polymarket-microbot")
    except PackageNotFoundError:
        return None


def measure_rtt(host: str) -> float:
    """Milliseconds for one REST round trip to the CLOB."""
    request = Request(f"{host}/time", headers={"User-Agent": "polymarket-microbot"})
    started = perf_counter()
    with urlopen(request, timeout=10) as response:
        response.read()
    return (perf_counter() - started) * 1000


def fee_for(market: Market, base_fee: float | None, default_rate: float) -> tuple[float, str]:
    """Effective taker rate: Gamma's feeSchedule, else the CLOB `base_fee` (bps), else config."""
    if market.fee_rate is not None:
        return market.fee_rate, f"gamma:feeSchedule base_fee={base_fee}"
    if base_fee is None:
        return default_rate, "config:lookup_failed"
    if base_fee == 0:
        return 0.0, "clob:base_fee=0"
    return default_rate, f"config:clob_base_fee={base_fee:g}"


def book_rows(event: dict, now: float, seq: int, connection_id: int) -> list[dict]:
    """Flatten one market-channel event into raw L2 rows."""
    kind = event.get("event_type", "")
    ts = event.get("timestamp")
    base = {"recv_ts": now, "exchange_ts": float(ts) / 1000 if ts else None, "seq": seq,
            "connection_id": connection_id, "market": event.get("market"), "event_type": kind}
    token = str(event.get("asset_id", ""))
    if kind == "book":
        rows = [base | {"token_id": token, "side": side, "price": float(level["price"]),
                        "size": float(level["size"]), "hash": event.get("hash")}
                for side, key in (("BUY", "bids"), ("SELL", "asks"))
                for level in event.get(key, [])]
        # An empty book still marks a snapshot.
        return rows or [base | {"token_id": token, "hash": event.get("hash")}]
    if kind == "price_change":
        # Per-change hashes are incompressible (about 3/4 of the bytes) and only snapshot
        # hashes are useful to check book integrity, so they are not kept here.
        return [base | {"token_id": str(c.get("asset_id", "")), "side": c.get("side"),
                        "price": float(c["price"]), "size": float(c["size"]),
                        "best_bid": _num(c.get("best_bid")), "best_ask": _num(c.get("best_ask"))}
                for c in event.get("price_changes", [])]
    if kind == "last_trade_price":
        return [base | {"token_id": token, "side": event.get("side"),
                        "price": _num(event.get("price")), "size": _num(event.get("size")),
                        "fee_rate_bps": _num(event.get("fee_rate_bps"))}]
    if kind == "tick_size_change":
        return [base | {"token_id": token, "price": _num(event.get("new_tick_size"))}]
    if kind == "best_bid_ask":
        return [base | {"token_id": token, "best_bid": _num(event.get("best_bid")),
                        "best_ask": _num(event.get("best_ask"))}]
    return [base | {"token_id": token}]


def snapshot_delta(book: OrderBook, event: dict, now: float, seq: int,
                   connection_id: int) -> list[dict]:
    """Levels of a `book` snapshot that differ from `book` (the state before applying it)."""
    ts = event.get("timestamp")
    base = {"recv_ts": now, "exchange_ts": float(ts) / 1000 if ts else None, "seq": seq,
            "connection_id": connection_id, "market": event.get("market"), "event_type": "book",
            "token_id": book.token_id, "hash": event.get("hash"), "is_delta": True}
    rows = []
    for side, key, old in (("BUY", "bids", book.bids), ("SELL", "asks", book.asks)):
        new = {float(level["price"]): float(level["size"]) for level in event.get(key, [])}
        for price in sorted(set(old) | set(new)):
            if new.get(price, 0.0) != old.get(price, 0.0):
                rows.append(base | {"side": side, "price": price, "size": new.get(price, 0.0)})
    return rows


def book_state(books: dict[str, OrderBook], tags: dict[str, dict], depth: int, now: float,
               connection_id: int) -> dict:
    """Top `depth` levels per side of the books being traded, best first."""
    tokens = {}
    for token, book in books.items():
        tokens[token] = {
            "market": tags.get(token, {}).get("market"),
            "outcome": tags.get(token, {}).get("outcome"),
            "tick_size": book.tick_size,
            "updated_at": book.updated_at or None,
            "bids": [[p, book.bids[p]] for p in book.prices("bid")[:depth]],
            "asks": [[p, book.asks[p]] for p in book.prices("ask")[:depth]],
        }
    return {"ts": now, "connection_id": connection_id, "tokens": tokens}


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":")))
    tmp.replace(path)


def _num(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


async def run() -> None:
    s = Settings()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log = logging.getLogger("microbot")
    run_id = uuid4().hex
    engine = FeatureEngine(s)
    predictor = ModelPredictor(s.model_path) if s.model_path else None
    model_version = predictor.version if predictor else "heuristic"
    feat_version = features_version(s)
    broker = LiveBroker(s) if s.mode == "live" else PaperBroker(s)
    storage = Storage(s.db_path, s.parquet_dir)
    ledger = Ledger(s.paper_starting_cash)
    books_writer = (
        PartitionedWriter(s.parquet_dir / "book_events", BOOK_EVENT_COLUMNS, "recv_ts",
                          s.book_flush_seconds, s.book_retention_days)
        if s.record_book_events else None
    )
    # Latest book and tags per token, kept after rollover so leftover positions can be marked.
    marks: dict[str, OrderBook] = {}
    all_tags: dict[str, dict] = {}
    # Books, tags and stream of the market being traded, for the dashboard's book file.
    current: dict = {"books": {}, "tags": {}, "stream": None}
    in_flight: dict[str, float] = {}
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    storage.upsert("runs", {
        "run_id": run_id, "started_at": time(), "mode": s.mode, "git_commit": git_commit(),
        "version": package_version(), "features_version": feat_version,
        "model_version": model_version, "fee_rate": s.fee_rate,
        "starting_cash": s.paper_starting_cash,
        "settings_json": json.dumps(s.model_dump(mode="json", exclude=SECRETS), sort_keys=True),
    })
    log.info("Started run=%s mode=%s; %s", run_id, s.mode,
             f"series={s.series_slug}" if s.series_slug else f"tokens={s.yes_token_id},{s.no_token_id}")

    def stream_event(kind: str, token: str | None = None, value: float | None = None,
                     detail: str = "", connection_id: int | None = None) -> None:
        storage.insert("stream_events", {
            "ts": time(), "run_id": run_id, "connection_id": connection_id, "kind": kind,
            "token_id": token, "value": value, "detail": detail,
        })

    def record_fill(fill, tags: dict) -> None:
        storage.insert("fills", fill.as_dict() | tags | {"run_id": run_id})
        ledger.on_fill(fill)
        snapshot()
        log.info("%s %s %.2f @ %.4f fee=%.5f pnl=%.4f (%s)", fill.mode, fill.side, fill.size,
                 fill.price, fill.fee, fill.pnl, fill.reason)

    def record_execution(execution: Execution, tags: dict) -> None:
        storage.insert("orders", execution.order.as_dict() | {"run_id": run_id})
        if execution.fill:
            record_fill(execution.fill, tags)
        elif execution.order.reject_reason:
            log.info("Order %s %s rejected: %s", execution.order.side, execution.order.token_id,
                     execution.order.reject_reason)

    def snapshot() -> None:
        now = time()
        current = {t: Mark(b.midpoint, b.best_bid) for t, b in marks.items()}
        row, positions = ledger.snapshot(now, broker.positions(), current, all_tags,
                                         sum(in_flight.values()))
        storage.insert("equity", row | {"run_id": run_id})
        for position in positions:
            storage.insert("positions", position | {"run_id": run_id})

    resolver = Resolver(storage, broker, record_fill)

    async def markets() -> AsyncIterator[Market]:
        if not s.series_slug:
            yield Market("", "", s.yes_token_id, s.no_token_id)
            return
        while True:
            # The extra second keeps a market that is just being left from being picked again.
            after = time() + s.rollover_seconds + 1
            try:
                market = await find_series_market(s.series_slug, after)
            except (OSError, ValueError) as exc:
                log.warning("Could not look up series %s (%s)", s.series_slug, exc)
                market = None
            if market:
                yield market
            else:
                log.warning("No open market in series %s; retrying in %ss", s.series_slug,
                            SERIES_RETRY_SECONDS)
                await asyncio.sleep(SERIES_RETRY_SECONDS)

    async def consume() -> None:
        async for market in markets():
            await trade_market(market)

    async def register_market(market: Market) -> None:
        base_fees = {}
        for token in (market.yes_token_id, market.no_token_id):
            base_fees[token] = await fetch_fee_rate_bps(s.clob_host, token)
            rate, source = fee_for(market, base_fees[token], s.fee_rate)
            broker.fees.set(token, rate, source, market.fee_exponent)
        if not market.slug:
            return
        base_fee = base_fees[market.yes_token_id]
        rate, source = fee_for(market, base_fee, s.fee_rate)
        existing = storage.get("markets", market.slug)
        storage.upsert("markets", market.as_dict() | {
            "fee_rate_bps": base_fee, "fee_rate": rate, "fee_source": source, "run_id": run_id,
            "first_seen_ts": existing["first_seen_ts"] if existing else time(),
        })

    async def trade_market(market: Market) -> None:
        ms = s.model_copy(update={"yes_token_id": market.yes_token_id,
                                  "no_token_id": market.no_token_id})
        books = {t: OrderBook(t) for t in (ms.yes_token_id, ms.no_token_id)}
        if market.tick_size:
            for book in books.values():
                book.tick_size = market.tick_size
        await register_market(market)
        strategy = MicrostructureStrategy(ms)

        def on_status(kind: str, connection_id: int, detail: str) -> None:
            stream_event(kind, None, None, detail, connection_id)
            if kind == "connect" and connection_id > 1:
                health["resync_at"] = time()

        stream = MarketStream(s.ws_url, list(books), on_status)
        tags = {t: {"market": market.slug, "outcome": market.outcome(t)} for t in books}
        marks.update(books)
        all_tags.update(tags)
        current.update(books=books, tags=tags, stream=stream)
        health = {"resync_at": 0.0}
        if market.slug:
            log.info("Market %s (%s) until %s", market.slug, market.question,
                     datetime.fromtimestamp(market.end_ts, UTC).astimezone().strftime("%H:%M:%S"))
        deadline = market.end_ts - s.rollover_seconds
        tasks: set[asyncio.Task] = set()
        try:
            async with asyncio.timeout(None if math.isinf(deadline) else max(0.0, deadline - time())):
                await consume_market(ms, market, books, strategy, stream, tags, health, tasks)
        except TimeoutError:
            pass
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await close_positions(market, books, tags)
        for token in books:
            engine.state.pop(token, None)

    async def close_positions(market: Market, books: dict[str, OrderBook],
                              tags: dict[str, dict]) -> None:
        for token, pos in list(broker.positions().items()):
            if not pos.open or token not in books:
                continue
            bid = books[token].best_bid
            if bid is None:
                log.warning("Leaving %.2f of %s open: no bids before rollover", pos.size, token)
                continue
            intent = Intent(token, "SELL", pos.size, max(MIN_LIMIT_PRICE, bid - s.max_slippage),
                            "rollover")
            context = OrderContext(time(), market.slug, market.outcome(token))
            record_execution(await broker.submit(intent, books[token], context), tags[token])

    def predict(market: Market, strategy: MicrostructureStrategy, rows: dict[str, FeatureRow],
                probabilities: dict[str, float], signal_value: float, now: float,
                in_gap: bool, action: str | None = None, reason: str | None = None) -> str:
        decision = strategy.last_decision
        token = decision.token_id or market.yes_token_id
        row = rows.get(token)
        prediction_id = uuid4().hex
        action = action or decision.action
        reason = reason or decision.reason
        storage.insert("predictions", {
            "prediction_id": prediction_id, "ts": now, "run_id": run_id, "market": market.slug,
            "token_id": token, "outcome": market.outcome(token), "model_version": model_version,
            "features_version": feat_version, "probability": probabilities.get(token),
            "signal": signal_value,
            "decision": f"filtered:{reason}" if action == "skip" else action,
            "reason": reason, "threshold": decision.threshold,
            "price_at_decision": row.best_ask if row else None,
            "intended_size": decision.intended_size if action in ("enter", "exit") else 0.0,
            "in_gap": in_gap,
        })
        return prediction_id

    async def execute(intent: Intent, book: OrderBook, context: OrderContext,
                      tags: dict) -> None:
        in_flight[context.market] = intent.size * intent.limit_price
        try:
            record_execution(await broker.submit(intent, book, context), tags)
        finally:
            in_flight.pop(context.market, None)

    async def consume_market(ms: Settings, market: Market, books: dict[str, OrderBook],
                             strategy: MicrostructureStrategy, stream: MarketStream,
                             tags: dict[str, dict], health: dict,
                             tasks: set[asyncio.Task]) -> None:
        last_feature_at = 0.0
        last_event_at: dict[str, float] = {}
        gap_until = 0.0
        stale: set[str] = set()
        seq, connection = 0, 0
        last_full: dict[str, tuple[int, float]] = {}
        async for event in stream.events():
            kind = event.get("event_type")
            token = str(event.get("asset_id", ""))
            now = time()
            # The exchange publishes no sequence numbers; count events per connection.
            if stream.connection_id != connection:
                seq, connection = 0, stream.connection_id
            seq += 1
            if books_writer:
                full = last_full.get(token)
                if (kind == "book" and token in books and full and full[0] == connection
                        and now - full[1] < FULL_SNAPSHOT_SECONDS):
                    rows_l2 = snapshot_delta(books[token], event, now, seq, connection)
                else:
                    rows_l2 = book_rows(event, now, seq, connection)
                    if kind == "book":
                        last_full[token] = (connection, now)
                books_writer.extend(r | {"run_id": run_id} for r in rows_l2)
            touched = [token] if token in books else [
                str(c.get("asset_id", "")) for c in event.get("price_changes", [])
            ]
            for t in touched:
                previous = last_event_at.get(t)
                if previous and now - previous > ms.gap_seconds:
                    stream_event("gap", t, now - previous, "", stream.connection_id)
                    gap_until = now + ms.gap_seconds
                last_event_at[t] = now
            if health["resync_at"] and kind == "book":
                stream_event("resync", token, now - health["resync_at"], "",
                             stream.connection_id)
                gap_until = now + ms.gap_seconds
                health["resync_at"] = 0.0

            if kind == "book" and token in books:
                book = books[token]
                prev = book.top()
                book.replace(event.get("bids", []), event.get("asks", []), event.get("timestamp"))
                engine.on_book_event(token, prev, book.top(), now)
            elif kind == "price_change":
                for change in event.get("price_changes", []):
                    token = str(change.get("asset_id", ""))
                    if token in books:
                        book = books[token]
                        prev = book.top()
                        book.update_level(change.get("side", ""), change["price"], change["size"],
                                          event.get("timestamp"))
                        engine.on_book_event(token, prev, book.top(), now)
            elif kind == "last_trade_price" and token in books:
                engine.on_trade(token, event.get("side", ""), float(event.get("size", 0)), now)
            elif kind == "tick_size_change" and token in books:
                books[token].tick_size = float(event.get("new_tick_size") or books[token].tick_size)

            if now - last_feature_at < ms.feature_interval_ms / 1000:
                continue
            last_feature_at = now
            in_gap = now < gap_until
            rows: dict[str, FeatureRow] = {}
            probabilities: dict[str, float] = {}
            for token, book in books.items():
                if not book.updated_at or now - book.updated_at > ms.stale_book_seconds:
                    if token not in stale and book.updated_at:
                        stale.add(token)
                        stream_event("stale_book", token, now - book.updated_at, "",
                                     stream.connection_id)
                    continue
                stale.discard(token)
                row = engine.calculate(book, now)
                if row is None:
                    continue
                if predictor:
                    probabilities[token] = predictor.probability(row)
                    row.score = max(-1.0, min(1.0, 2 * probabilities[token] - 1))
                rows[token] = row
            signal_value = combine_market(rows, ms.yes_token_id, ms.no_token_id)
            for token, row in rows.items():
                storage.insert("features", row.as_dict() | tags[token]
                               | {"in_gap": in_gap, "run_id": run_id})
            if not rows:
                continue
            if ms.mode == "record":
                strategy.last_decision.token_id = ""
                predict(market, strategy, rows, probabilities, signal_value, now, in_gap,
                        "observe", "record_mode")
                continue
            if market.slug in in_flight:
                predict(market, strategy, rows, probabilities, signal_value, now, in_gap,
                        "skip", "order_in_flight")
                continue
            intents = strategy.decide(rows, broker.positions(), now)
            prediction_id = predict(market, strategy, rows, probabilities, signal_value, now,
                                    in_gap)
            for intent in intents:
                context = OrderContext(now, market.slug, market.outcome(intent.token_id),
                                       prediction_id)
                task = asyncio.create_task(
                    execute(intent, books[intent.token_id], context, tags[intent.token_id]))
                tasks.add(task)
                task.add_done_callback(tasks.discard)

    async def export_periodically() -> None:
        while True:
            await asyncio.sleep(s.export_interval_seconds)
            storage.export_parquet()
            if books_writer:
                await asyncio.to_thread(books_writer.maybe_flush)

    async def snapshot_periodically() -> None:
        while True:
            await asyncio.sleep(s.snapshot_interval_seconds)
            snapshot()

    async def measure_periodically() -> None:
        while True:
            try:
                rtt = await asyncio.to_thread(measure_rtt, s.clob_host)
                broker.rtt_ms = rtt
                stream_event("rtt", None, rtt)
            except OSError as exc:
                stream_event("rtt_error", None, None, str(exc)[:200])
            await asyncio.sleep(s.rtt_interval_seconds)

    async def write_book_periodically() -> None:
        while True:
            await asyncio.sleep(s.book_state_seconds)
            stream = current["stream"]
            state = book_state(current["books"], current["tags"], s.book_state_depth, time(),
                               stream.connection_id if stream else 0)
            try:
                await asyncio.to_thread(write_json_atomic, s.book_state_path, state)
            except OSError as exc:
                log.warning("Could not write %s (%s)", s.book_state_path, exc)

    async def resolve_periodically() -> None:
        while True:
            await resolver.poll()
            await asyncio.sleep(s.resolver_interval_seconds)

    # Run independently of market traffic so Ctrl+C and exports work even in quiet markets.
    tasks = [asyncio.create_task(consume()), asyncio.create_task(stop.wait()),
             asyncio.create_task(snapshot_periodically()),
             asyncio.create_task(measure_periodically()),
             asyncio.create_task(resolve_periodically())]
    if s.export_interval_seconds:
        tasks.append(asyncio.create_task(export_periodically()))
    if s.book_state_seconds:
        tasks.append(asyncio.create_task(write_book_periodically()))
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if not task.cancelled() and task.exception():
                raise task.exception()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        snapshot()
        storage.upsert("runs", {"run_id": run_id, "ended_at": time()})
        if books_writer:
            books_writer.close()
        storage.close()
        log.info("Stopped; Parquet export complete")


def main() -> None:
    parser = argparse.ArgumentParser(description="Polymarket microstructure bot")
    parser.parse_args()
    asyncio.run(run())


if __name__ == "__main__":
    main()
