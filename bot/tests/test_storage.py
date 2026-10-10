from datetime import UTC, datetime

import duckdb

from microbot.storage import BOOK_EVENT_COLUMNS, PartitionedWriter, Storage

HOUR = datetime(2026, 10, 8, 21, tzinfo=UTC).timestamp()


def test_old_databases_gain_new_tables_and_columns(tmp_path):
    db = tmp_path / "bot.duckdb"
    con = duckdb.connect(str(db))
    con.execute("CREATE TABLE fills (ts DOUBLE, token_id VARCHAR)")
    con.execute("INSERT INTO fills VALUES (1, 'yes')")
    con.close()
    storage = Storage(db, tmp_path / "parquet")
    columns = {r["column_name"] for r in storage.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'fills'")}
    assert {"liquidity", "fee_source", "run_id"} <= columns
    assert storage.query("SELECT count(*) AS n FROM orders") == [{"n": 0}]
    storage.close()
    for table in ("orders", "markets", "equity", "predictions", "stream_events", "runs"):
        assert (tmp_path / "parquet" / f"{table}.parquet").exists()


def test_insert_ignores_unknown_keys_and_upsert_merges(tmp_path):
    storage = Storage(tmp_path / "bot.duckdb", tmp_path / "parquet")
    storage.insert("stream_events", {"ts": 1.0, "kind": "rtt", "value": 80.0, "extra": "x"})
    assert storage.query("SELECT kind, value FROM stream_events") == [{"kind": "rtt", "value": 80.0}]
    storage.upsert("markets", {"slug": "m", "question": "Q", "end_ts": 10.0})
    storage.upsert("markets", {"slug": "m", "resolved": True, "winner": "YES"})
    row = storage.get("markets", "m")
    assert (row["question"], row["end_ts"], row["resolved"], row["winner"]) == ("Q", 10.0, True, "YES")
    assert storage.query("SELECT count(*) AS n FROM markets") == [{"n": 1}]
    storage.close()


def book_row(ts: float, seq: int) -> dict:
    return {"recv_ts": ts, "seq": seq, "event_type": "price_change", "token_id": "yes",
            "side": "BUY", "price": 0.5, "size": 10.0}


def read(path) -> list[tuple]:
    return duckdb.connect().execute(
        f"SELECT seq FROM read_parquet('{path.as_posix()}/*.parquet') ORDER BY seq").fetchall()


def test_partitioned_writer_writes_hourly_parts_then_compacts(tmp_path):
    directory = tmp_path / "book_events"
    writer = PartitionedWriter(directory, BOOK_EVENT_COLUMNS, "recv_ts", flush_seconds=60)
    writer.extend([book_row(HOUR + 10, 1), book_row(HOUR + 20, 2)])
    writer.flush(now=HOUR + 30)
    writer.extend([book_row(HOUR + 3599, 3), book_row(HOUR + 3601, 4)])
    writer.flush(now=HOUR + 3602)
    # The finished hour is compacted; the current hour stays as a part.
    names = sorted(p.name for p in directory.iterdir())
    assert names == ["20261008-21.parquet", "20261008-22-3.parquet"]
    assert read(directory) == [(1,), (2,), (3,), (4,)]
    types = duckdb.connect().execute(
        f"DESCRIBE SELECT * FROM read_parquet('{directory.as_posix()}/*.parquet')").fetchall()
    kinds = {name: kind for name, kind, *_ in types}
    assert (kinds["is_delta"], kinds["seq"], kinds["price"]) == ("BOOLEAN", "BIGINT", "DOUBLE")
    writer.flush(now=HOUR + 2 * 3600 + 5)
    assert sorted(p.name for p in directory.iterdir()) == [
        "20261008-21.parquet", "20261008-22.parquet"]


def test_partitioned_writer_only_flushes_on_interval_and_prunes(tmp_path):
    directory = tmp_path / "book_events"
    writer = PartitionedWriter(directory, BOOK_EVENT_COLUMNS, "recv_ts", flush_seconds=60,
                               retention_days=1)
    writer.last_flush = HOUR
    writer.append(book_row(HOUR, 1))
    writer.maybe_flush(now=HOUR + 30)
    assert not list(directory.iterdir())
    writer.maybe_flush(now=HOUR + 61)
    assert len(list(directory.iterdir())) == 1
    writer.flush(now=HOUR + 3 * 86400)
    assert not list(directory.iterdir())
    # Sequence numbers continue after a restart so parts never collide.
    writer.append(book_row(HOUR + 3 * 86400, 2))
    writer.flush(now=HOUR + 3 * 86400)
    assert PartitionedWriter(directory, BOOK_EVENT_COLUMNS, "recv_ts").sequence > writer.sequence - 1
