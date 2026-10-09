import "server-only";
import { open, stat } from "node:fs/promises";
import { type AsyncBuffer, type FileMetaData, parquetMetadataAsync, parquetRead } from "hyparquet";

/** Same order as FEATURE_COLUMNS in bot/src/microbot/model.py. */
export const FEATURE_COLUMNS = [
  "spread_ticks",
  "weighted_imbalance",
  "book_imbalance",
  "microprice_delta",
  "ofi",
  "flow_imbalance",
  "trade_pressure",
  "volatility",
] as const;

export const FEATURES_SPEC = {
  numeric: ["ts", "best_bid", "best_ask", "midpoint", "spread", "score", "trade_volume", ...FEATURE_COLUMNS],
  strings: ["token_id", "market", "outcome"],
} as const;

export const FILLS_SPEC = {
  numeric: ["ts", "size", "price", "fee", "pnl"],
  strings: ["token_id", "side", "order_id", "mode", "reason", "outcome"],
} as const;

type Spec = { numeric: readonly string[]; strings: readonly string[] };

const BOOT = Date.now().toString(36);
let generation = 0;

/** Reads through one open handle, so an atomic replace of the file mid-read can't mix two files. */
function handleBuffer(handle: Awaited<ReturnType<typeof open>>, size: number): AsyncBuffer {
  return {
    byteLength: size,
    async slice(start, end = size) {
      const bytes = Buffer.allocUnsafe(end - start);
      await handle.read(bytes, 0, bytes.length, start);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
  };
}

/**
 * Columnar, append-only mirror of one Parquet export. The bot rewrites the whole file every few
 * seconds but only ever appends rows, so each sync decodes just the rows past `count` after checking
 * that the last known row is unchanged; anything else (a new database) rebuilds from scratch and
 * bumps `version`.
 */
export class ColumnStore<S extends Spec = Spec> {
  version = "";
  count = 0;
  num = {} as Record<S["numeric"][number], Float64Array>;
  code = {} as Record<S["strings"][number], Int32Array>;
  dict = {} as Record<S["strings"][number], string[]>;
  private lookup = {} as Record<S["strings"][number], Map<string, number>>;
  private capacity = 0;
  private key = "";
  private pending: Promise<void> | null = null;

  constructor(readonly file: string, readonly spec: S) {
    this.reset();
  }

  /** String column value at row `i`, or null. */
  str(column: S["strings"][number], i: number): string | null {
    const c = this.code[column][i];
    return c < 0 ? null : this.dict[column][c];
  }

  intern(column: S["strings"][number], value: string): number {
    return this.lookup[column].get(value) ?? -1;
  }

  /** Cheap when the file is unchanged (one stat); otherwise reads only the new rows. */
  async sync(): Promise<void> {
    if (this.pending) return this.pending;
    const info = await stat(this.file).catch(() => null);
    if (!info) {
      if (this.count) this.reset();
      this.key = "";
      return;
    }
    const key = `${info.mtimeMs}:${info.size}`;
    if (key === this.key) return;
    this.pending = this.load(key).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private reset() {
    this.version = `${BOOT}.${++generation}`;
    this.count = 0;
    this.capacity = 0;
    for (const c of this.spec.numeric as S["numeric"][number][]) this.num[c] = new Float64Array(0);
    for (const c of this.spec.strings as S["strings"][number][]) {
      this.code[c] = new Int32Array(0);
      this.dict[c] = [];
      this.lookup[c] = new Map();
    }
  }

  private grow(rows: number) {
    if (rows <= this.capacity) return;
    const capacity = Math.max(rows, this.capacity * 2, 1024);
    for (const c of this.spec.numeric as S["numeric"][number][]) {
      const next = new Float64Array(capacity);
      next.set(this.num[c].subarray(0, this.count));
      this.num[c] = next;
    }
    for (const c of this.spec.strings as S["strings"][number][]) {
      const next = new Int32Array(capacity);
      next.set(this.code[c].subarray(0, this.count));
      this.code[c] = next;
    }
    this.capacity = capacity;
  }

  private async load(key: string) {
    const handle = await open(this.file, "r");
    try {
      const { size } = await handle.stat();
      const file = handleBuffer(handle, size);
      const metadata = await parquetMetadataAsync(file);
      const rows = Number(metadata.num_rows);
      let from = 0;
      if (this.count > 0 && rows >= this.count) {
        const last = this.count - 1;
        let tail = NaN;
        await parquetRead({
          file,
          metadata,
          columns: ["ts"],
          rowStart: last,
          rowEnd: this.count,
          onChunk: (chunk) => {
            if (chunk.rowStart <= last && last < chunk.rowEnd) tail = Number(chunk.columnData[last - chunk.rowStart]);
          },
        });
        if (tail === (this.num as Record<string, Float64Array>).ts[last]) from = this.count;
      }
      if (from === 0) this.reset();
      if (rows > from) await this.read(file, metadata, from, rows);
      this.key = key;
    } finally {
      await handle.close();
    }
  }

  private async read(file: AsyncBuffer, metadata: FileMetaData, from: number, to: number) {
    this.grow(to);
    const present = new Set(metadata.schema.map((s) => s.name));
    const numeric = new Set<string>(this.spec.numeric);
    const strings = new Set<string>(this.spec.strings);
    const columns = [...numeric, ...strings].filter((c) => present.has(c));
    await parquetRead({
      file,
      metadata,
      columns,
      rowStart: from,
      rowEnd: to,
      onChunk: ({ columnName, columnData, rowStart, rowEnd }) => {
        const lo = Math.max(rowStart, from);
        const hi = Math.min(rowEnd, to);
        if (numeric.has(columnName)) {
          const target = this.num[columnName as S["numeric"][number]];
          for (let i = lo; i < hi; i++) {
            const v = columnData[i - rowStart];
            target[i] = v == null ? NaN : Number(v);
          }
        } else if (strings.has(columnName)) {
          const name = columnName as S["strings"][number];
          const target = this.code[name];
          const lookup = this.lookup[name];
          const dict = this.dict[name];
          for (let i = lo; i < hi; i++) {
            const v = columnData[i - rowStart];
            if (v == null) {
              target[i] = -1;
              continue;
            }
            const s = String(v);
            let c = lookup.get(s);
            if (c === undefined) {
              c = dict.length;
              dict.push(s);
              lookup.set(s, c);
            }
            target[i] = c;
          }
        }
      },
    });
    // Exports from older bots lack the newer columns.
    for (const c of numeric) if (!present.has(c)) this.num[c as S["numeric"][number]].fill(NaN, from, to);
    for (const c of strings) if (!present.has(c)) this.code[c as S["strings"][number]].fill(-1, from, to);
    this.count = to;
  }
}

export type FeatureStore = ColumnStore<typeof FEATURES_SPEC>;
export type FillsStore = ColumnStore<typeof FILLS_SPEC>;

const stores = new Map<string, ColumnStore>();

function storeFor<S extends Spec>(file: string, spec: S): ColumnStore<S> {
  let store = stores.get(file);
  if (!store) {
    store = new ColumnStore(file, spec);
    stores.set(file, store);
  }
  return store as unknown as ColumnStore<S>;
}

export async function featureStore(file: string): Promise<FeatureStore> {
  const store = storeFor(file, FEATURES_SPEC);
  await store.sync();
  return store;
}

export async function fillsStore(file: string): Promise<FillsStore> {
  const store = storeFor(file, FILLS_SPEC);
  await store.sync();
  return store;
}

/** Growable list of row indices. */
export class RowList {
  rows = new Int32Array(64);
  length = 0;

  push(i: number) {
    if (this.length === this.rows.length) {
      const next = new Int32Array(this.rows.length * 2);
      next.set(this.rows);
      this.rows = next;
    }
    this.rows[this.length++] = i;
  }

  view() {
    return this.rows.subarray(0, this.length);
  }
}

export type TokenRows = {
  list: RowList;
  /** Bumped whenever the rows had to be re-sorted, which invalidates incremental state built on them. */
  epoch: number;
  sorted: boolean;
};

export type Span = { market: number; yes: number; no: number; start: number; end: number };

const YES = 0;
const NO = 1;

/** Per-token row lists (time-ordered), market spans and the latest row, maintained as rows arrive. */
export class FeatureIndex {
  version = "";
  processed = 0;
  tokens = new Map<number, TokenRows>();
  spans = new Map<number, Span>();
  latest = -1;
  private outcomeCodes: [number, number] = [-1, -1];

  update(store: FeatureStore) {
    if (this.version !== store.version) {
      this.version = store.version;
      this.processed = 0;
      this.tokens.clear();
      this.spans.clear();
      this.latest = -1;
    }
    if (this.processed === store.count) return;
    this.outcomeCodes = [store.intern("outcome", "YES"), store.intern("outcome", "NO")];
    const ts = store.num.ts;
    const token = store.code.token_id;
    const market = store.code.market;
    const outcome = store.code.outcome;
    for (let i = this.processed; i < store.count; i++) {
      const t = ts[i];
      if (this.latest < 0 || t > ts[this.latest]) this.latest = i;
      let rows = this.tokens.get(token[i]);
      if (!rows) {
        rows = { list: new RowList(), epoch: 0, sorted: true };
        this.tokens.set(token[i], rows);
      }
      const prev = rows.list.length ? ts[rows.list.rows[rows.list.length - 1]] : -Infinity;
      if (t < prev) rows.sorted = false;
      rows.list.push(i);
      if (market[i] < 0) continue;
      let span = this.spans.get(market[i]);
      if (!span) {
        span = { market: market[i], yes: -1, no: -1, start: t, end: t };
        this.spans.set(market[i], span);
      }
      if (t < span.start) span.start = t;
      if (t > span.end) span.end = t;
      if (outcome[i] === this.outcomeCodes[YES]) span.yes = token[i];
      else if (outcome[i] === this.outcomeCodes[NO]) span.no = token[i];
    }
    this.processed = store.count;
    for (const rows of this.tokens.values()) {
      if (rows.sorted) continue;
      const view = rows.list.view();
      view.sort((a, b) => ts[a] - ts[b] || a - b);
      rows.sorted = true;
      rows.epoch++;
    }
  }

  /** Spans in chronological order. */
  markets(): Span[] {
    return [...this.spans.values()].sort((a, b) => a.start - b.start);
  }
}

const indexes = new WeakMap<FeatureStore, FeatureIndex>();

export function featureIndex(store: FeatureStore): FeatureIndex {
  let index = indexes.get(store);
  if (!index) {
    index = new FeatureIndex();
    indexes.set(store, index);
  }
  index.update(store);
  return index;
}

/** Largest `i` in [0, n) with `key(i) ≤ t` for an ascending `key`, or -1. */
export function lastAtOrBefore(n: number, key: (i: number) => number, t: number): number {
  let lo = 0;
  let hi = n - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(mid) <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
