/**
 * The dashboard's L2 replay against the bot's own replay (evaluate.apply_l2) over Parquet written
 * by the bot's PartitionedWriter, plus the live book.json path.
 *
 *   node scripts/run.mjs scripts/test-book.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { replayBook } from "../lib/book-replay";

const root = mkdtempSync(path.join(tmpdir(), "microbot-book-"));
process.env.MICROBOT_ROOT = root;
const python = path.resolve(__dirname, "../../bot/.bot/bin/python");

// Random walk of snapshots (full every 60 s, deltas otherwise) and price changes over 3 hours of
// two tokens, written in several flushes so files span hours, parts and compacted files.
const script = String.raw`
import json, random, sys
from pathlib import Path
from microbot.book import OrderBook
from microbot.evaluate import apply_l2, l2_items
from microbot.main import book_rows, snapshot_delta
from microbot.storage import BOOK_EVENT_COLUMNS, PartitionedWriter
import pandas as pd

root = Path(sys.argv[1])
rng = random.Random(7)
writer = PartitionedWriter(root / "data/parquet/book_events", BOOK_EVENT_COLUMNS, "recv_ts", 60, 0)
tokens = ["111", "222"]
books = {t: OrderBook(t) for t in tokens}
start = 1_791_590_000.0
last_full = {}
rows = []
seq = 0
t = start
while t < start + 3 * 3600:
    t += rng.uniform(0.5, 6)
    seq += 1
    token = rng.choice(tokens)
    if rng.random() < 0.3:
        mid = rng.randint(30, 70) / 100
        event = {"event_type": "book", "asset_id": token, "market": "m",
                 "bids": [{"price": f"{mid - i / 100:.2f}", "size": str(rng.randint(1, 50))} for i in range(1, rng.randint(2, 8))],
                 "asks": [{"price": f"{mid + i / 100:.2f}", "size": str(rng.randint(1, 50))} for i in range(1, rng.randint(2, 8))]}
        if token in last_full and t - last_full[token] < 60:
            new = snapshot_delta(books[token], event, t, seq, 1)
        else:
            new = book_rows(event, t, seq, 1)
            last_full[token] = t
        books[token].replace(event["bids"], event["asks"])
    else:
        side = rng.choice(["BUY", "SELL"])
        price = rng.randint(20, 80) / 100
        size = 0.0 if rng.random() < 0.3 else float(rng.randint(1, 40))
        event = {"event_type": "price_change", "market": "m",
                 "price_changes": [{"asset_id": token, "side": side, "price": str(price), "size": str(size)}]}
        new = book_rows(event, t, seq, 1)
        books[token].update_level(side, price, size)
    rows.extend(new)
    writer.extend(new)
    if seq % 400 == 0:
        writer.flush(t)
writer.flush(start + 3 * 3600 + 7200)

# Expected books at a few instants, replayed by the bot's evaluator from all rows.
frame = pd.DataFrame(rows)
items = l2_items(frame)
checks = [start + 600, start + 1800.3, start + 3600 - 1, start + 3600 + 2, start + 9000]
expected = []
for at in checks:
    replay = {tok: OrderBook(tok) for tok in tokens}
    for ts, _, _, group in items:
        if ts > at:
            break
        apply_l2(replay, group)
    expected.append({tok: {"bids": [[p, replay[tok].bids[p]] for p in replay[tok].prices("bid")[:20]],
                           "asks": [[p, replay[tok].asks[p]] for p in replay[tok].prices("ask")[:20]]}
                     for tok in tokens})
print(json.dumps({"checks": checks, "expected": expected}))
`;

async function main() {
  const out = execFileSync(python, ["-c", script, root], { maxBuffer: 64 * 1024 * 1024 }).toString();
  const { checks, expected } = JSON.parse(out) as {
    checks: number[];
    expected: Record<string, { bids: number[][]; asks: number[][] }>[];
  };
  const { loadBooks, replayBooks } = await import("../lib/book");

  for (const [i, at] of checks.entries()) {
    const books = await replayBooks(["111", "222"], at);
    for (const token of ["111", "222"]) {
      const want = expected[i][token];
      const got = books[token];
      if (!want.bids.length && !want.asks.length) continue;
      assert.ok(got, `book for ${token} at ${at}`);
      assert.deepEqual(got.bids, want.bids, `bids ${token} @ ${at}`);
      assert.deepEqual(got.asks, want.asks, `asks ${token} @ ${at}`);
    }
  }
  console.log(`replay matches the bot at ${checks.length} instants`);

  // Pure function: a delta before any full snapshot gives no book; the snapshot resets levels.
  const row = (recv_ts: number, seq: number, event_type: string, side: string | null, price: number | null, size: number | null, is_delta: boolean | null = null) =>
    ({ recv_ts, connection_id: 1, seq, event_type, token_id: "1", side, price, size, is_delta, market: "m" });
  const rows = [
    row(1, 1, "book", "BUY", 0.4, 5, true),
    row(2, 2, "book", "BUY", 0.41, 3),
    row(2, 2, "book", "SELL", 0.45, 4),
    row(3, 3, "price_change", "BUY", 0.41, 0),
    row(4, 4, "book", "SELL", 0.46, 9, true),
    row(5, 5, "tick_size_change", null, 0.001, null),
  ];
  assert.equal(replayBook(rows, "1", 1.5), null);
  assert.deepEqual(replayBook(rows, "1", 2)?.bids, [[0.41, 3]]);
  const late = replayBook(rows, "1", 10)!;
  assert.deepEqual(late.bids, []);
  assert.deepEqual(late.asks, [[0.45, 4], [0.46, 9]]);
  assert.equal(late.tickSize, 0.001);
  assert.equal(late.updatedAt, 4);

  // Live: a fresh book.json is served as is; a stale one falls back to the replay.
  mkdirSync(path.join(root, "data/bot"), { recursive: true });
  const now = Date.now() / 1000;
  const live = { ts: now, connection_id: 2, tokens: { "111": { market: "m", outcome: "YES", tick_size: 0.01, updated_at: now, bids: [[0.5, 1]], asks: [[0.52, 2]] } } };
  writeFileSync(path.join(root, "data/bot/book.json"), JSON.stringify(live));
  const fresh = await loadBooks(["111"], null);
  assert.equal(fresh.source, "live");
  assert.deepEqual(fresh.tokens["111"]?.asks, [[0.52, 2]]);
  writeFileSync(path.join(root, "data/bot/book.json"), JSON.stringify({ ...live, ts: now - 60 }));
  assert.equal((await loadBooks(["111"], null)).source, "replay");
  console.log("live and fallback ok");
}

main()
  .then(() => rmSync(root, { recursive: true, force: true }))
  .catch((error) => {
    rmSync(root, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
