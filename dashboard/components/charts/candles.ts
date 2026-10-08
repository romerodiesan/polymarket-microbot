export type Candle = { ts: number; open: number; high: number; low: number; close: number; volume: number };

/**
 * Groups (ts, value, volume) points into OHLC candles of `intervalSec`, keyed by bucket start.
 * At each timestamp in `breaks` (sorted, e.g. market rollovers) the next candle opens at its own
 * first value instead of the previous close.
 */
export function toCandles(
  points: { ts: number; value: number; volume?: number }[],
  intervalSec: number,
  breaks: number[] = [],
): Candle[] {
  const out: Candle[] = [];
  let nextBreak = 0;
  let broken = false;
  for (const p of points) {
    if (!Number.isFinite(p.value) || !Number.isFinite(p.ts)) continue;
    while (nextBreak < breaks.length && breaks[nextBreak] <= p.ts) {
      nextBreak++;
      broken = true;
    }
    const ts = Math.floor(p.ts / intervalSec) * intervalSec;
    const last = out.at(-1);
    if (last && last.ts === ts) {
      last.high = Math.max(last.high, p.value);
      last.low = Math.min(last.low, p.value);
      last.close = p.value;
      last.volume += p.volume ?? 0;
    } else if (!last || ts > last.ts) {
      // Open at the previous close so consecutive candles connect, like exchange charts.
      const open = last && !broken ? last.close : p.value;
      broken = false;
      out.push({
        ts,
        open,
        high: Math.max(open, p.value),
        low: Math.min(open, p.value),
        close: p.value,
        volume: p.volume ?? 0,
      });
    }
  }
  return out;
}

/** A sensible candle size for a visible span, aiming at roughly 60–200 candles. */
export function autoInterval(spanSec: number, intervals: readonly number[]): number {
  return intervals.find((i) => spanSec / i <= 200) ?? intervals[intervals.length - 1];
}
