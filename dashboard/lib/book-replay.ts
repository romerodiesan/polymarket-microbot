/** [price, size], best first. */
export type Level = [number, number];

export type BookSnapshot = {
  token: string;
  market: string | null;
  outcome: string | null;
  tickSize: number | null;
  bids: Level[];
  asks: Level[];
  /** Time of the last change applied (or reported by the bot). */
  updatedAt: number | null;
};

/** One raw `book_events` row, as recorded by the bot. */
export type BookEventRow = {
  recv_ts: number;
  connection_id: number | null;
  seq: number | null;
  event_type: string | null;
  token_id: string | null;
  side: string | null;
  price: number | null;
  size: number | null;
  is_delta: boolean | null;
  market: string | null;
};

const byArrival = (a: BookEventRow, b: BookEventRow) =>
  a.recv_ts - b.recv_ts || (a.connection_id ?? 0) - (b.connection_id ?? 0) || (a.seq ?? 0) - (b.seq ?? 0);

const sameMessage = (a: BookEventRow, b: BookEventRow) =>
  a.connection_id === b.connection_id && a.seq === b.seq && a.recv_ts === b.recv_ts;

const isFull = (r: BookEventRow) => r.event_type === "book" && !r.is_delta;

function levels(map: Map<number, number>, descending: boolean, depth: number): Level[] {
  return [...map.entries()]
    .sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]))
    .slice(0, depth);
}

/**
 * `token`'s book at `t`: the last full snapshot at or before `t`, then every delta, price change
 * and tick change up to `t`, as the bot applied them. Null when the rows hold no full snapshot.
 */
export function replayBook(rows: BookEventRow[], token: string, t: number, depth = 20): BookSnapshot | null {
  const events = rows.filter((r) => r.recv_ts <= t && r.token_id === token).sort(byArrival);
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (isFull(events[i])) {
      start = i;
      // Back up to the first row of that snapshot message.
      while (start > 0 && sameMessage(events[start - 1], events[i])) start--;
      break;
    }
  }
  if (start < 0) return null;

  const bids = new Map<number, number>();
  const asks = new Map<number, number>();
  let tickSize: number | null = null;
  let updatedAt: number | null = null;
  let market: string | null = null;
  const set = (side: string | null, price: number | null, size: number | null) => {
    if (price == null || size == null || (side !== "BUY" && side !== "SELL")) return;
    const book = side === "BUY" ? bids : asks;
    if (size <= 0) book.delete(price);
    else book.set(price, size);
  };

  for (let i = start; i < events.length; i++) {
    const r = events[i];
    market = r.market ?? market;
    if (isFull(r)) {
      if (i === 0 || !sameMessage(events[i - 1], r)) {
        bids.clear();
        asks.clear();
      }
      set(r.side, r.price, r.size);
    } else if (r.event_type === "book" || r.event_type === "price_change") {
      set(r.side, r.price, r.size);
    } else if (r.event_type === "tick_size_change") {
      if (r.price) tickSize = r.price;
      continue;
    } else {
      continue;
    }
    updatedAt = r.recv_ts;
  }
  return {
    token,
    market,
    outcome: null,
    tickSize,
    bids: levels(bids, true, depth),
    asks: levels(asks, false, depth),
    updatedAt,
  };
}
