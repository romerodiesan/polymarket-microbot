import { lastIndexAtOrBefore } from "@/components/charts/candles";
import type { BotMeta, FillColumns, LivePayload, SeriesColumns } from "@/lib/data";

/** One token's (or one side's) samples as parallel, append-only arrays; NaN where unrecorded. */
export type Series = {
  ts: number[];
  bid: number[];
  ask: number[];
  mid: number[];
  spread: number[];
  imbalance: number[];
  score: number[];
  volume: number[];
};

const FIELDS = ["ts", "bid", "ask", "mid", "spread", "imbalance", "score", "volume"] as const;

export type Fill = {
  ts: number;
  token_id: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  fee: number;
  order_id: string;
  mode: string;
  reason: string;
  pnl: number;
  /** YES/NO side within its market; null for fills recorded before markets were tagged. */
  outcome: string | null;
};

/** YES or NO as one continuous series across every market of a rolling series (or the fixed token). */
export type Side = { label: "YES" | "NO"; tokens: Set<string>; points: Series; fills: Fill[] };

/** Running cash after each fill and, per token, its position after each of its fills. */
export type Ledger = { cashAfter: number[]; tokens: Map<string, { at: number[]; position: number[] }> };

export type LiveSnapshot = BotMeta & {
  features: Map<string, Series>;
  /** Chronological. */
  fills: Fill[];
  ledger: Ledger;
  sides: [Side, Side];
  /** Starts of every market after the first, stable between snapshots unless a market is added. */
  breaks: number[];
  range: { min: number; max: number } | null;
};

const emptySeries = (): Series => ({ ts: [], bid: [], ask: [], mid: [], spread: [], imbalance: [], score: [], volume: [] });

function appendColumns(target: Series, source: SeriesColumns) {
  for (const field of FIELDS) {
    const to = target[field];
    for (const v of source[field]) to.push(v ?? NaN);
  }
}

/** Fresh arrays (callers cache by array identity), sorted by time. */
function sortedCopy(series: Series): Series {
  const order = series.ts.map((_, i) => i).sort((a, b) => series.ts[a] - series.ts[b] || a - b);
  const out = emptySeries();
  for (const field of FIELDS) out[field] = order.map((i) => series[field][i]);
  return out;
}

const isSorted = (ts: number[], from = 1) => {
  for (let i = Math.max(1, from); i < ts.length; i++) if (ts[i] < ts[i - 1]) return false;
  return true;
};

function toFills(columns: FillColumns): Fill[] {
  return columns.ts.map((ts, i) => ({
    ts,
    token_id: columns.token_id[i],
    side: columns.side[i] as Fill["side"],
    size: columns.size[i],
    price: columns.price[i],
    fee: columns.fee[i],
    order_id: columns.order_id[i],
    mode: columns.mode[i],
    reason: columns.reason[i],
    pnl: columns.pnl[i],
    outcome: columns.outcome[i],
  }));
}

/**
 * The live page's data, built from one full load and then the rows appended since. Series arrays
 * grow in place (chart caches key on them), everything derived is extended rather than rebuilt.
 */
export class LiveStore {
  private version = "";
  private cursor = 0;
  private fillsCursor = 0;
  private features = new Map<string, Series>();
  private fills: Fill[] = [];
  private ledger: Ledger = { cashAfter: [], tokens: new Map() };
  private sides: [Side, Side] | null = null;
  private breaks: number[] = [];
  private startingCash = NaN;

  /** Query string asking for what was appended since the last applied payload. */
  query(): string {
    if (!this.version) return "";
    return `?v=${encodeURIComponent(this.version)}&since=${this.cursor}&fsince=${this.fillsCursor}`;
  }

  /** Applies a payload answering `query()`; returns null if it no longer continues this store. */
  apply(payload: LivePayload, askedFor: string): LiveSnapshot | null {
    if (askedFor !== this.query()) return null;
    const touched = new Set<string>();
    if (payload.reset) {
      this.features = new Map();
      this.fills = [];
      this.sides = null;
    }
    for (const [token, columns] of Object.entries(payload.features)) {
      let series = this.features.get(token);
      if (!series) {
        series = emptySeries();
        this.features.set(token, series);
      }
      const from = series.ts.length;
      appendColumns(series, columns);
      if (!isSorted(series.ts, from)) this.features.set(token, sortedCopy(series));
      touched.add(token);
    }

    const newFills = toFills(payload.fills);
    const lastTs = this.fills.at(-1)?.ts ?? -Infinity;
    const appended = !newFills.length || (newFills[0].ts >= lastTs && isSorted(newFills.map((f) => f.ts)));
    if (newFills.length) this.fills = this.fills.concat(newFills);
    if (!appended) this.fills.sort((a, b) => a.ts - b.ts);
    const rebuildLedger = payload.reset || !appended || payload.config.startingCash !== this.startingCash;
    if (rebuildLedger) {
      this.startingCash = payload.config.startingCash;
      this.ledger = { cashAfter: [], tokens: new Map() };
      this.extendLedger(0);
    } else if (newFills.length) {
      this.extendLedger(this.fills.length - newFills.length);
    }

    const starts = payload.markets.slice(1).map((m) => m.start);
    if (starts.length !== this.breaks.length || starts.some((s, i) => s !== this.breaks[i])) this.breaks = starts;

    const fillsAdded = appended ? newFills : null;
    this.sides = [
      this.side("YES", "yes", payload, touched, fillsAdded),
      this.side("NO", "no", payload, touched, fillsAdded),
    ];
    this.version = payload.version;
    this.cursor = payload.cursor;
    this.fillsCursor = payload.fillsCursor;

    const { market, tokens, config, exportedAt, totalFeatureRows, markets } = payload;
    return {
      market,
      tokens,
      config,
      exportedAt,
      totalFeatureRows,
      markets,
      features: this.features,
      fills: this.fills,
      ledger: this.ledger,
      sides: this.sides,
      breaks: this.breaks,
      range: this.range(),
    };
  }

  private extendLedger(from: number) {
    const { cashAfter, tokens } = this.ledger;
    let cash = from ? cashAfter[from - 1] : this.startingCash;
    for (let i = from; i < this.fills.length; i++) {
      const f = this.fills[i];
      const signed = f.side === "BUY" ? f.size : -f.size;
      cash -= signed * f.price + f.fee;
      cashAfter.push(cash);
      let book = tokens.get(f.token_id);
      if (!book) {
        book = { at: [], position: [] };
        tokens.set(f.token_id, book);
      }
      book.at.push(i);
      book.position.push((book.position.at(-1) ?? 0) + signed);
    }
  }

  /**
   * Appends to the existing side when its tokens are unchanged and the new samples come later;
   * `newFills` is null when the fills were re-sorted and the side's fills must be filtered again.
   */
  private side(label: Side["label"], key: "yes" | "no", payload: LivePayload, touched: Set<string>, newFills: Fill[] | null): Side {
    const ids = payload.markets.length ? payload.markets.map((m) => m[key]).filter(Boolean) : [payload.tokens[key]];
    const previous = this.sides?.[label === "YES" ? 0 : 1];
    const sameTokens = previous && previous.tokens.size === ids.length && ids.every((id) => previous.tokens.has(id));
    if (previous && sameTokens && this.appendToSide(previous.points, ids.filter((id) => touched.has(id)).map((id) => payload.features[id]))) {
      if (!newFills) return { ...previous, fills: this.fills.filter((f) => previous.tokens.has(f.token_id)) };
      const fills = newFills.filter((f) => previous.tokens.has(f.token_id));
      return fills.length ? { ...previous, fills: previous.fills.concat(fills) } : previous;
    }
    const tokens = new Set(ids);
    const points = emptySeries();
    for (const id of ids) {
      const series = this.features.get(id);
      if (!series) continue;
      for (const field of FIELDS) {
        const to = points[field];
        for (const v of series[field]) to.push(v);
      }
    }
    return {
      label,
      tokens,
      points: isSorted(points.ts) ? points : sortedCopy(points),
      fills: this.fills.filter((f) => tokens.has(f.token_id)),
    };
  }

  private appendToSide(points: Series, added: (SeriesColumns | undefined)[]): boolean {
    const chunks = added.filter((c): c is SeriesColumns => !!c && c.ts.length > 0);
    if (!chunks.length) return true;
    const merged = emptySeries();
    for (const chunk of chunks) appendColumns(merged, chunk);
    const ordered = isSorted(merged.ts) ? merged : sortedCopy(merged);
    if (points.ts.length && ordered.ts[0] < points.ts[points.ts.length - 1]) return false;
    for (const field of FIELDS) {
      const to = points[field];
      for (const v of ordered[field]) to.push(v);
    }
    return true;
  }

  private range(): LiveSnapshot["range"] {
    let min = Infinity;
    let max = -Infinity;
    for (const series of this.features.values()) {
      if (!series.ts.length) continue;
      min = Math.min(min, series.ts[0]);
      max = Math.max(max, series.ts[series.ts.length - 1]);
    }
    if (!Number.isFinite(min)) return null;
    // A fill can land just after the last feature sample; keep it visible in live mode.
    const lastFill = this.fills.at(-1);
    if (lastFill && lastFill.ts > max) max = lastFill.ts;
    return { min, max };
  }
}

const fillTimesCache = new WeakMap<Fill[], number[]>();

/** Timestamps of `fills`, cached per array. */
export function fillTimes(fills: Fill[]): number[] {
  let times = fillTimesCache.get(fills);
  if (!times) {
    times = fills.map((f) => f.ts);
    fillTimesCache.set(fills, times);
  }
  return times;
}

/** Number of `fills` at or before `t`. */
export const fillsAt = (fills: Fill[], t: number) => lastIndexAtOrBefore(fillTimes(fills), t) + 1;

/** Mid of `token` at its last sample ≤ `t`, if any. */
export function midAt(snapshot: LiveSnapshot, token: string, t: number): number | undefined {
  const series = snapshot.features.get(token);
  if (!series) return undefined;
  const i = lastIndexAtOrBefore(series.ts, t);
  return i >= 0 ? series.mid[i] : undefined;
}
