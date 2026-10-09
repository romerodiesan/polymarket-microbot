import type { TimePoint } from "./time-series";

export type Candle = { ts: number; open: number; high: number; low: number; close: number; volume: number };

/** Index of the last element of ascending `values` that is ≤ `t`, or -1. */
export function lastIndexAtOrBefore(values: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = values.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

type BreakState = { nextBreak: number; broken: boolean };

/**
 * OHLC candles of `interval` seconds over parallel, append-only `ts`/`values` (and optional `volume`)
 * arrays, keyed by bucket start. At each timestamp in `breaks` (sorted, e.g. market rollovers) the
 * next candle opens at its own first value instead of the previous close.
 *
 * Built once and extended as points are appended: `sync` only re-feeds the last candle. `upTo(t)`
 * shares the complete candles and builds just the one containing `t`.
 */
export class CandleSeries {
  readonly candles: Candle[] = [];
  /** Index of the first point of each candle. */
  private readonly starts: number[] = [];
  private fed = 0;
  private state: BreakState = { nextBreak: 0, broken: false };
  /** Break state just before the last candle's first point, to re-feed it. */
  private lastState: BreakState = { nextBreak: 0, broken: false };
  private readonly mapped = new Map<string, TimePoint[]>();
  hasVolume = false;

  constructor(
    readonly ts: number[],
    readonly values: number[],
    readonly volume: number[] | null,
    readonly interval: number,
    readonly breaks: number[],
  ) {}

  sync() {
    if (this.fed === this.ts.length) return;
    let from = this.fed;
    if (this.candles.length) {
      this.candles.pop();
      from = this.starts.pop()!;
      this.state = { ...this.lastState };
    }
    for (let i = from; i < this.ts.length; i++) this.feed(i);
    this.fed = this.ts.length;
  }

  private feed(i: number) {
    const t = this.ts[i];
    const value = this.values[i];
    if (!Number.isFinite(value) || !Number.isFinite(t)) return;
    const before = this.state;
    let { nextBreak, broken } = before;
    while (nextBreak < this.breaks.length && this.breaks[nextBreak] <= t) {
      nextBreak++;
      broken = true;
    }
    const volume = this.volume?.[i] || 0;
    if (volume > 0) this.hasVolume = true;
    const bucket = Math.floor(t / this.interval) * this.interval;
    const last = this.candles.at(-1);
    if (last && last.ts === bucket) {
      last.high = Math.max(last.high, value);
      last.low = Math.min(last.low, value);
      last.close = value;
      last.volume += volume;
      this.state = { nextBreak, broken };
    } else if (!last || bucket > last.ts) {
      // Open at the previous close so consecutive candles connect, like exchange charts.
      const open = last && !broken ? last.close : value;
      this.lastState = before;
      this.candles.push({
        ts: bucket,
        open,
        high: Math.max(open, value),
        low: Math.min(open, value),
        close: value,
        volume,
      });
      this.starts.push(i);
      this.state = { nextBreak, broken: false };
    }
  }

  /** Candles fully before `t` (shared, `count` of them) plus the one containing `t`, cut at `t`. */
  private slice(t: number): { count: number; tail: Candle | null } {
    const end = lastIndexAtOrBefore(this.ts, t);
    if (end < 0 || !this.candles.length) return { count: 0, tail: null };
    const k = lastIndexAtOrBefore(this.starts, end);
    if (k < 0) return { count: 0, tail: null };
    const nextStart = this.starts[k + 1] ?? this.ts.length;
    const candle = this.candles[k];
    if (end >= nextStart - 1) return { count: k, tail: candle };
    const tail = { ...candle, high: candle.open, low: candle.open, close: candle.open, volume: 0 };
    for (let i = this.starts[k]; i <= end; i++) {
      const value = this.values[i];
      if (!Number.isFinite(value)) continue;
      tail.high = Math.max(tail.high, value);
      tail.low = Math.min(tail.low, value);
      tail.close = value;
      tail.volume += this.volume?.[i] || 0;
    }
    return { count: k, tail };
  }

  upTo(t: number): Candle[] {
    const { count, tail } = this.slice(t);
    if (!tail) return [];
    if (count === this.candles.length - 1 && tail === this.candles[count]) return this.candles;
    const out = this.candles.slice(0, count);
    out.push(tail);
    return out;
  }

  /**
   * `map` of each candle up to `t`. Complete candles are mapped once and reused (keyed by `key`), so
   * consecutive calls return the same objects for everything but the last point.
   */
  pointsUpTo(t: number, key: string, map: (c: Candle) => TimePoint): TimePoint[] {
    const { count, tail } = this.slice(t);
    if (!tail) return [];
    let done = this.mapped.get(key);
    if (!done) {
      done = [];
      this.mapped.set(key, done);
    }
    // Only candles before the last one are final; the last is still growing.
    const stable = Math.min(count, this.candles.length - 1);
    for (let i = done.length; i < stable; i++) done.push(map(this.candles[i]));
    const out = done.slice(0, count);
    out.push(map(tail));
    return out;
  }
}

const caches = new WeakMap<number[], Map<number, CandleSeries>>();

/** The cached candle series of `values` at `interval`, extended to the current length. */
export function candleSeries(
  ts: number[],
  values: number[],
  interval: number,
  breaks: number[],
  volume: number[] | null = null,
): CandleSeries {
  let byInterval = caches.get(values);
  if (!byInterval) {
    byInterval = new Map();
    caches.set(values, byInterval);
  }
  let series = byInterval.get(interval);
  if (!series || series.ts !== ts || series.breaks !== breaks || series.volume !== volume) {
    series = new CandleSeries(ts, values, volume, interval, breaks);
    byInterval.set(interval, series);
  }
  series.sync();
  return series;
}

/** A sensible candle size for a visible span, aiming at roughly 60–200 candles. */
export function autoInterval(spanSec: number, intervals: readonly number[]): number {
  return intervals.find((i) => spanSec / i <= 200) ?? intervals[intervals.length - 1];
}
