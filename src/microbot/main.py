import argparse
import asyncio
import logging
import signal
from time import time

from .book import OrderBook
from .broker import LiveBroker, PaperBroker
from .config import Settings
from .features import FeatureEngine, combine_market
from .model import ModelPredictor
from .storage import Storage
from .strategy import MicrostructureStrategy
from .ws import MarketStream


async def run() -> None:
    s = Settings()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log = logging.getLogger("microbot")
    books = {t: OrderBook(t) for t in (s.yes_token_id, s.no_token_id)}
    engine = FeatureEngine(s)
    predictor = ModelPredictor(s.model_path) if s.model_path else None
    strategy = MicrostructureStrategy(s)
    broker = LiveBroker(s) if s.mode == "live" else PaperBroker(s)
    storage = Storage(s.db_path, s.parquet_dir)
    stream = MarketStream(s.ws_url, list(books))
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    log.info("Started mode=%s; tokens=%s", s.mode, ",".join(books))

    async def consume() -> None:
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

            if now - last_feature_at < s.feature_interval_ms / 1000:
                continue
            last_feature_at = now
            rows = {}
            for token, book in books.items():
                if not book.updated_at or now - book.updated_at > s.stale_book_seconds:
                    continue
                row = engine.calculate(book, now)
                if row is None:
                    continue
                if predictor:
                    row.score = predictor.score(row)
                rows[token] = row
            combine_market(rows, s.yes_token_id, s.no_token_id)
            for row in rows.values():
                storage.insert("features", row.as_dict())
            if s.mode == "record" or not rows:
                continue
            for intent in strategy.decide(rows, broker.positions(), now):
                fill = await broker.submit(intent, books[intent.token_id])
                if fill:
                    storage.insert("fills", fill.as_dict())
                    log.info("%s %s %.2f @ %.4f pnl=%.4f (%s)", fill.mode, fill.side, fill.size,
                             fill.price, fill.pnl, fill.reason)

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

