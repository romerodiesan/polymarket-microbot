import { toCandles } from "@/components/charts/candles";
import type { TimePoint } from "@/components/charts/time-series";
import type { BotData, FeaturePoint } from "@/lib/data";

export function lastIndexAtOrBefore(points: { ts: number }[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].ts <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export function upTo<T extends { ts: number }>(points: T[], t: number): T[] {
  const end = lastIndexAtOrBefore(points, t);
  return end === points.length - 1 ? points : points.slice(0, end + 1);
}

export function portfolioAt(data: BotData, t: number) {
  let cash = data.config.startingCash;
  const positions: Record<string, number> = {};
  for (const f of data.fills) {
    if (f.ts > t) break;
    const signed = f.side === "BUY" ? f.size : -f.size;
    cash -= signed * f.price + f.fee;
    positions[f.token_id] = (positions[f.token_id] ?? 0) + signed;
  }
  let equity = cash;
  for (const [token, pos] of Object.entries(positions)) {
    const points = data.features[token] ?? [];
    const i = lastIndexAtOrBefore(points, t);
    if (i >= 0) equity += pos * points[i].mid;
  }
  return { cash, positions, equity, pnl: equity - data.config.startingCash };
}

export function equityCurve(data: BotData) {
  const tokens = Object.keys(data.features);
  const timeline = tokens
    .flatMap((token) => data.features[token].map((p) => ({ ts: p.ts, token, mid: p.mid })))
    .sort((a, b) => a.ts - b.ts);
  const lastMid: Record<string, number> = {};
  const positions: Record<string, number> = {};
  let cash = data.config.startingCash;
  let fillIdx = 0;
  const out: { ts: number; equity: number }[] = [];
  const step = Math.max(1, Math.floor(timeline.length / 3000));
  timeline.forEach((p, i) => {
    lastMid[p.token] = p.mid;
    while (fillIdx < data.fills.length && data.fills[fillIdx].ts <= p.ts) {
      const f = data.fills[fillIdx++];
      const signed = f.side === "BUY" ? f.size : -f.size;
      cash -= signed * f.price + f.fee;
      positions[f.token_id] = (positions[f.token_id] ?? 0) + signed;
    }
    if (i % step === 0 || i === timeline.length - 1) {
      let equity = cash;
      for (const [token, pos] of Object.entries(positions)) equity += pos * (lastMid[token] ?? 0);
      out.push({ ts: p.ts, equity });
    }
  });
  return out;
}

/** Distance below the running equity peak (≤ 0). */
export function drawdownOf(curve: { ts: number; equity: number }[]) {
  let peak = -Infinity;
  return curve.map((p) => {
    peak = Math.max(peak, p.equity);
    return { ts: p.ts, value: p.equity - peak };
  });
}

export type Outcome = { label: "YES" | "NO"; color: string; tokens: Set<string>; points: FeaturePoint[] };

/** YES and NO as continuous series: across every market of a rolling series, or the fixed tokens. */
export function outcomes(data: BotData, colors: { up: string; down: string }): Outcome[] {
  const build = (side: "yes" | "no", label: Outcome["label"], color: string): Outcome => {
    const ids = data.markets.length ? data.markets.map((m) => m[side]).filter(Boolean) : [data.tokens[side]];
    const points = ids.flatMap((id) => data.features[id] ?? []).sort((a, b) => a.ts - b.ts);
    return { label, color, tokens: new Set(ids), points };
  };
  return [build("yes", "YES", colors.up), build("no", "NO", colors.down)];
}

/** Last value per candle bucket, so every chart in the group shares the same time slots. */
export function bucketed<T extends { ts: number }>(
  points: T[],
  value: (p: T) => number,
  interval: number,
  breaks: number[],
): TimePoint[] {
  return toCandles(points.map((p) => ({ ts: p.ts, value: value(p) })), interval, breaks).map((c) => ({
    ts: c.ts,
    value: c.close,
  }));
}
