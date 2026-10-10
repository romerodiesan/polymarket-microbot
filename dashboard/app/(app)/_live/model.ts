import type { ChartMarker } from "@/components/charts/time-series";
import { lastIndexAtOrBefore } from "@/components/charts/candles";
import { fmtFixed } from "@/lib/format";
import { type Fill, type LiveSnapshot, fillsAt, midAt } from "./live-store";

/** Cash, positions and marked equity at `t`, from the fill ledger: O(log F) per token with fills. */
export function portfolioAt(data: LiveSnapshot, t: number) {
  const k = fillsAt(data.fills, t);
  const cash = k ? data.ledger.cashAfter[k - 1] : data.config.startingCash;
  const positions: Record<string, number> = {};
  let equity = cash;
  for (const [token, book] of data.ledger.tokens) {
    const j = lastIndexAtOrBefore(book.at, k - 1);
    if (j < 0) continue;
    const position = book.position[j];
    positions[token] = position;
    if (!position) continue;
    const mid = midAt(data, token, t);
    if (mid !== undefined && Number.isFinite(mid)) equity += position * mid;
  }
  return { cash, positions, equity, pnl: equity - data.config.startingCash, fills: k };
}

/** Equity sampled over the whole range, with its drawdown and the worst drawdown so far. */
export type EquityCurve = { ts: number[]; equity: number[]; drawdown: number[]; worst: number[] };

const MAX_SAMPLES = 15000;
/** Grid steps, coarsest last; the step only changes when the range outgrows one. */
const STEPS = [2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
/** Samples this close to the end are recomputed on the next update (late rows can still move them). */
const SETTLE_SECONDS = 60;

type CurveState = {
  cash: number;
  open: Map<string, number>;
  next: number;
  peak: number;
  worst: number;
  g: number;
  length: number;
  lastFill: Fill | undefined;
};

type CurveCache = { min: number; step: number; startingCash: number; checkpoint: CurveState; curve: EquityCurve };

/** Keyed by the store's token map, which lives until a full reload. */
const curveCache = new WeakMap<LiveSnapshot["features"], CurveCache>();

/**
 * Equity on a regular grid plus every fill time: positions change only at fills, so each sample
 * marks the few open positions at their mid (binary search), with no sorting. Successive snapshots
 * resume from a checkpoint SETTLE_SECONDS before the previous end, so an update costs O(new samples).
 */
export function equityCurve(data: LiveSnapshot): EquityCurve {
  if (!data.range) return { ts: [], equity: [], drawdown: [], worst: [] };
  const { min, max } = data.range;
  const step = STEPS.find((s) => (max - min) / s <= MAX_SAMPLES) ?? STEPS[STEPS.length - 1];
  const startingCash = data.config.startingCash;
  const { fills } = data;

  const cached = curveCache.get(data.features);
  const resume =
    cached &&
    cached.min === min &&
    cached.step === step &&
    cached.startingCash === startingCash &&
    cached.checkpoint.next <= fills.length &&
    fills[cached.checkpoint.next - 1] === cached.checkpoint.lastFill;
  const from: CurveState = resume
    ? cached.checkpoint
    : { cash: startingCash, open: new Map(), next: 0, peak: -Infinity, worst: 0, g: min, length: 0, lastFill: undefined };
  const out: EquityCurve = resume
    ? {
        ts: cached.curve.ts.slice(0, from.length),
        equity: cached.curve.equity.slice(0, from.length),
        drawdown: cached.curve.drawdown.slice(0, from.length),
        worst: cached.curve.worst.slice(0, from.length),
      }
    : { ts: [], equity: [], drawdown: [], worst: [] };

  let { cash, next, peak, worst, g } = from;
  const open = new Map(from.open);
  let checkpoint: CurveState | null = null;

  const sample = (t: number) => {
    if (out.ts.length && t <= out.ts[out.ts.length - 1]) return;
    while (next < fills.length && fills[next].ts <= t) {
      const f = fills[next++];
      const signed = f.side === "BUY" ? f.size : -f.size;
      cash -= signed * f.price + f.fee;
      const position = (open.get(f.token_id) ?? 0) + signed;
      if (Math.abs(position) < 1e-12) open.delete(f.token_id);
      else open.set(f.token_id, position);
    }
    let equity = cash;
    for (const [token, position] of open) {
      const mid = midAt(data, token, t);
      if (mid !== undefined && Number.isFinite(mid)) equity += position * mid;
    }
    peak = Math.max(peak, equity);
    worst = Math.min(worst, equity - peak);
    out.ts.push(t);
    out.equity.push(equity);
    out.drawdown.push(equity - peak);
    out.worst.push(worst);
  };

  const settled = max - SETTLE_SECONDS;
  while (g < max) {
    const fillTs = next < fills.length ? fills[next].ts : Infinity;
    const t = Math.min(fillTs, g);
    if (!checkpoint && t > settled) {
      checkpoint = { cash, open: new Map(open), next, peak, worst, g, length: out.ts.length, lastFill: fills[next - 1] };
    }
    if (fillTs < g) sample(fillTs);
    else {
      sample(g);
      g += step;
    }
  }
  checkpoint ??= { cash, open: new Map(open), next, peak, worst, g, length: out.ts.length, lastFill: fills[next - 1] };
  sample(max);
  curveCache.set(data.features, { min, step, startingCash, checkpoint, curve: out });
  return out;
}

/** Worst drawdown up to `t` (≤ 0). */
export function maxDrawdownAt(curve: EquityCurve, t: number) {
  const i = lastIndexAtOrBefore(curve.ts, t);
  return i >= 0 ? curve.worst[i] : 0;
}

const feeSums = new WeakMap<Fill[], number[]>();

/** Fees paid by the first `count` fills, from prefix sums built once per fills array. */
export function feesUpTo(fills: Fill[], count: number): number {
  let sums = feeSums.get(fills);
  if (!sums) {
    sums = [0];
    for (const f of fills) sums.push(sums[sums.length - 1] + (f.fee || 0));
    feeSums.set(fills, sums);
  }
  return sums[Math.min(count, fills.length)];
}

const markerCache = new WeakMap<Fill[], ChartMarker[]>();

/** Chart markers for `fills`, built once per fills array; slice to the visible count. */
export function fillMarkers(fills: Fill[]): ChartMarker[] {
  let markers = markerCache.get(fills);
  if (!markers) {
    markers = fills.map((f) =>
      f.reason === "settlement"
        ? { ts: f.ts, price: f.price, kind: "settle", text: `Liq. ${fmtFixed(f.price, 0)}` }
        : {
            ts: f.ts,
            price: f.price,
            kind: f.side === "BUY" ? "buy" : "sell",
            text: `${f.side === "BUY" ? "C" : "V"} ${fmtFixed(f.size, 1)}`,
          },
    );
    markerCache.set(fills, markers);
  }
  return markers;
}
