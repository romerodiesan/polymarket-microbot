"""Synthetic bot export for benchmarks: features/fills Parquet shaped like production.

usage: python make-fixture.py <bot_root> <feature_rows> [fill_rows] [--append ROWS]
"""

import sys
from pathlib import Path

import duckdb

FEATURES = """
SELECT
    1791400000 + i * 0.29 AS ts,
    'tok-' || (i * 0.29 // 900)::BIGINT || '-' || (i % 2) AS token_id,
    m - 0.005 AS best_bid,
    m + 0.005 AS best_ask,
    m AS midpoint,
    0.01 AS spread,
    100 + (i % 37) AS bid_depth_3,
    90 + (i % 41) AS ask_depth_3,
    sin(i / 13.0) AS book_imbalance,
    m AS microprice,
    cos(i / 7.0) / 10 AS microprice_delta,
    sin(i / 3.0) AS flow_imbalance,
    cos(i / 11.0) AS trade_pressure,
    sin(i / 500.0) / 2 AS score,
    sin(i / 17.0) AS weighted_imbalance,
    cos(i / 19.0) * 3 AS ofi,
    0.01 + abs(sin(i / 900.0)) / 50 AS volatility,
    1.0 AS spread_ticks,
    10.0 AS top_bid_size,
    12.0 AS top_ask_size,
    CASE WHEN i % 5 = 0 THEN 3.0 ELSE 0.0 END AS trade_volume,
    'btc-updown-15m-' || (1791400000 + (i * 0.29 // 900)::BIGINT * 900) AS market,
    CASE WHEN i % 2 = 0 THEN 'YES' ELSE 'NO' END AS outcome
FROM (
    SELECT i, round(
        0.5 + (0.3 * sin(i / 4000.0) + 0.05 * sin(i / 300.0)) * (CASE WHEN i % 2 = 0 THEN 1 ELSE -1 END), 3
    ) AS m
    FROM range({start}, {end}) t(i)
)
"""

FILLS = """
SELECT
    1791400000 + j * {step} AS ts,
    'tok-' || ((j * {step}) // 900)::BIGINT || '-' || (j // 2 % 2) AS token_id,
    CASE WHEN j % 2 = 0 THEN 'BUY' ELSE 'SELL' END AS side,
    5.0 AS size,
    0.5 + (j % 7) / 100 AS price,
    0.0 AS fee,
    'o' || j AS order_id,
    'paper' AS mode,
    CASE WHEN j % 2 = 0 THEN 'entry' ELSE 'signal_faded' END AS reason,
    CASE WHEN j % 2 = 0 THEN NULL ELSE ((j % 5) - 2) / 100 END AS pnl,
    'btc-updown-15m-' || (1791400000 + ((j * {step}) // 900)::BIGINT * 900) AS market,
    CASE WHEN j // 2 % 2 = 0 THEN 'YES' ELSE 'NO' END AS outcome
FROM range(0, {fills}) t(j)
"""


def main() -> None:
    root = Path(sys.argv[1])
    rows = int(sys.argv[2])
    fills = int(sys.argv[3]) if len(sys.argv) > 3 and not sys.argv[3].startswith("--") else 8500
    parquet = root / "data" / "parquet"
    parquet.mkdir(parents=True, exist_ok=True)
    (root / ".env").write_text("PM_MODE=paper\nPM_SERIES_SLUG=btc-up-or-down-15m\n")
    con = duckdb.connect()
    con.execute(f"CREATE TABLE features AS {FEATURES.format(start=0, end=rows)}")
    if "--append" in sys.argv:
        extra = int(sys.argv[sys.argv.index("--append") + 1])
        con.execute(f"INSERT INTO features {FEATURES.format(start=rows, end=rows + extra)}")
    step = rows * 0.29 / fills
    con.execute(f"CREATE TABLE fills AS {FILLS.format(step=step, fills=fills)}")
    for table in ("features", "fills"):
        target = (parquet / f"{table}.parquet").as_posix()
        con.execute(f"COPY {table} TO '{target}' (FORMAT PARQUET, ROW_GROUP_SIZE 16384)")


if __name__ == "__main__":
    main()
