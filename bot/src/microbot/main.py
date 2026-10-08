import argparse
import asyncio
import logging
import math
import signal
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from time import time

from .book import OrderBook
from .broker import LiveBroker, PaperBroker
from .config import Settings
from .features import FeatureEngine, combine_market
from .markets import Market, find_series_market
from .model import ModelPredictor
from .storage import Storage
from .strategy import MIN_LIMIT_PRICE, Intent, MicrostructureStrategy
from .ws import MarketStream

SERIES_RETRY_SECONDS = 15


async def run() -> None:
    s = Settings()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log = logging.getLogger("microbot")
    engine = FeatureEngine(s)
    predictor = ModelPredictor(s.model_path) if s.model_path else None
    broker = LiveBroker(s) if s.mode == "live" else PaperBroker(s)
    storage = Storage(s.db_path, s.parquet_dir)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    log.info("Started mode=%s; %s", s.mode,
             f"series={s.series_slug}" if s.series_slug else f"tokens={s.yes_token_id},{s.no_token_id}")

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

    async def trade_market(market: Market) -> None:
        ms = s.model_copy(update={"yes_token_id": market.yes_token_id,
                                  "no_token_id": market.no_token_id})
        books = {t: OrderBook(t) for t in (ms.yes_token_id, ms.no_token_id)}
        strategy = MicrostructureStrategy(ms)
        stream = MarketStream(s.ws_url, list(books))
        tags = {t: {"market": market.slug, "outcome": market.outcome(t)} for t in books}
        if market.slug:
            log.info("Market %s (%s) until %s", market.slug, market.question,
                     datetime.fromtimestamp(market.end_ts, UTC).astimezone().strftime("%H:%M:%S"))
        deadline = market.end_ts - s.rollover_seconds
        try:
            async with asyncio.timeout(None if math.isinf(deadline) else max(0.0, deadline - time())):
                await consume_market(ms, books, strategy, stream, tags)
        except TimeoutError:
            pass
        await close_positions(books, tags)
        for token in books:
            engine.state.pop(token, None)

    async def close_positions(books: dict[str, OrderBook], tags: dict[str, dict]) -> None:
        for token, pos in list(broker.positions().items()):
            if not pos.open or token not in books:
                continue
            bid = books[token].best_bid
            if bid is None:
                log.warning("Leaving %.2f of %s open: no bids before rollover", pos.size, token)
                continue
            intent = Intent(token, "SELL", pos.size, max(MIN_LIMIT_PRICE, bid - s.max_slippage),
                            "rollover")
            fill = await broker.submit(intent, books[token])
            if fill:
                record_fill(fill, tags[token])

    def record_fill(fill, tags: dict) -> None:
        storage.insert("fills", fill.as_dict() | tags)
        log.info("%s %s %.2f @ %.4f pnl=%.4f (%s)", fill.mode, fill.side, fill.size,
                 fill.price, fill.pnl, fill.reason)

    async def consume_market(ms: Settings, books: dict[str, OrderBook],
                             strategy: MicrostructureStrategy, stream: MarketStream,
                             tags: dict[str, dict]) -> None:
        last_feature_at = 0.0
        async for event in stream.events():
            kind = event.get("event_type")
            token = str(event.get("asset_id", ""))
            now = time()
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
            rows = {}
            for token, book in books.items():
                if not book.updated_at or now - book.updated_at > ms.stale_book_seconds:
                    continue
                row = engine.calculate(book, now)
                if row is None:
                    continue
                if predictor:
                    row.score = predictor.score(row)
                rows[token] = row
            combine_market(rows, ms.yes_token_id, ms.no_token_id)
            for token, row in rows.items():
                storage.insert("features", row.as_dict() | tags[token])
            if ms.mode == "record" or not rows:
                continue
            for intent in strategy.decide(rows, broker.positions(), now):
                fill = await broker.submit(intent, books[intent.token_id])
                if fill:
                    record_fill(fill, tags[intent.token_id])

    async def export_periodically() -> None:
        while True:
            await asyncio.sleep(s.export_interval_seconds)
            storage.export_parquet()

    # Run independently of market traffic so Ctrl+C and exports work even in quiet markets.
    tasks = [asyncio.create_task(consume()), asyncio.create_task(stop.wait())]
    if s.export_interval_seconds:
        tasks.append(asyncio.create_task(export_periodically()))
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if not task.cancelled() and task.exception():
                raise task.exception()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        storage.close()
        log.info("Stopped; Parquet export complete")


def main() -> None:
    parser = argparse.ArgumentParser(description="Polymarket microstructure bot")
    parser.parse_args()
    asyncio.run(run())


if __name__ == "__main__":
    main()

