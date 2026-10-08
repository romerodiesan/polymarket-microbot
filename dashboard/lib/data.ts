import "server-only";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { ROOT, readEnvFile } from "./env";

export { ROOT, readEnvFile };
/** Most recent span sent at full resolution; older history is merged per token. */
const FULL_RES_SECONDS = 2 * 3600;
const MAX_OLD_POINTS_PER_TOKEN = 600;

export type FeaturePoint = {
  ts: number;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  imbalance: number;
  score: number;
  /** Shares traded since the previous point (0 for rows recorded before volume existed). */
  volume: number;
};

/** One market of a rolling series, as recorded (start/end are the first and last rows). */
export type MarketSpan = { slug: string; yes: string; no: string; start: number; end: number };

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

export type BotData = {
  market: { question: string | null; url: string | null };
  tokens: { yes: string; no: string };
  config: {
    mode: string;
    startingCash: number;
    signalThreshold: number;
    exitThreshold: number;
  };
  exportedAt: number | null;
  totalFeatureRows: number;
  features: Record<string, FeaturePoint[]>;
  /** Chronological; empty when following fixed token IDs. */
  markets: MarketSpan[];
  fills: Fill[];
};

const parquetCache = new Map<string, { key: string; rows: Promise<Record<string, unknown>[]> }>();

export async function readParquet(file: string): Promise<Record<string, unknown>[]> {
  if (!existsSync(file)) return [];
  const { mtimeMs, size } = statSync(file);
  const key = `${mtimeMs}:${size}`;
  const cached = parquetCache.get(file);
  if (cached?.key === key) return cached.rows;
  const rows = asyncBufferFromFile(file).then((buffer) => parquetReadObjects({ file: buffer }));
  parquetCache.set(file, { key, rows });
  rows.catch(() => parquetCache.delete(file));
  return rows;
}

/**
 * Keeps points newer than `cutoff` at full resolution and merges older ones into at most
 * `maxOld` points: each keeps the last values of its chunk and the chunk's summed volume.
 */
function compact(points: FeaturePoint[], cutoff: number, maxOld: number): FeaturePoint[] {
  const split = points.findIndex((p) => p.ts >= cutoff);
  const old = split < 0 ? points : points.slice(0, split);
  const recent = split < 0 ? [] : points.slice(split);
  if (old.length <= maxOld) return points;
  const step = Math.ceil(old.length / maxOld);
  const merged: FeaturePoint[] = [];
  for (let i = 0; i < old.length; i += step) {
    const chunk = old.slice(i, i + step);
    merged.push({ ...chunk[chunk.length - 1], volume: chunk.reduce((acc, p) => acc + p.volume, 0) });
  }
  return merged.concat(recent);
}

const marketCache = new Map<string, BotData["market"]>();

export async function lookupMarket(tokenId: string): Promise<BotData["market"]> {
  if (!tokenId) return { question: null, url: null };
  const cached = marketCache.get(tokenId);
  if (cached) return cached;
  try {
    const res = await fetch(
      `https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`,
      { signal: AbortSignal.timeout(4000) },
    );
    const [market] = (await res.json()) as { question?: string; slug?: string }[];
    const info = {
      question: market?.question ?? null,
      url: market?.slug ? `https://polymarket.com/market/${market.slug}` : null,
    };
    marketCache.set(tokenId, info);
    return info;
  } catch {
    return { question: null, url: null };
  }
}

/** Fixed tokens from .env, or with PM_SERIES_SLUG the YES/NO tokens of the latest recorded market. */
export function currentTokens(env: Record<string, string>, rows: Record<string, unknown>[]) {
  const fixed = { yes: env.PM_YES_TOKEN_ID ?? "", no: env.PM_NO_TOKEN_ID ?? "" };
  if (!env.PM_SERIES_SLUG || !rows.length) return fixed;
  const latest = rows.reduce((a, b) => (Number(b.ts) > Number(a.ts) ? b : a));
  const tokens = { yes: "", no: "" };
  for (const r of rows) {
    if (r.market !== latest.market) continue;
    if (r.outcome === "YES") tokens.yes = String(r.token_id);
    if (r.outcome === "NO") tokens.no = String(r.token_id);
    if (tokens.yes && tokens.no) break;
  }
  return tokens;
}

function parquetPaths(env: Record<string, string>) {
  const parquetDir = path.resolve(/*turbopackIgnore: true*/ ROOT, env.PM_PARQUET_DIR || "data/parquet");
  return {
    featuresFile: path.join(parquetDir, "features.parquet"),
    fillsFile: path.join(parquetDir, "fills.parquet"),
  };
}

const exportedAtOf = (file: string) => (existsSync(file) ? statSync(file).mtimeMs / 1000 : null);

export type BotStatus = { mode: string; exportedAt: number | null };

/** Cheap enough to poll from every page: no Parquet reads. */
export function loadBotStatus(): BotStatus {
  const env = readEnvFile();
  return { mode: env.PM_MODE || "paper", exportedAt: exportedAtOf(parquetPaths(env).featuresFile) };
}

export async function loadBotData(): Promise<BotData> {
  const env = readEnvFile();
  const { featuresFile, fillsFile } = parquetPaths(env);

  const [rawFeatures, rawFills] = await Promise.all([readParquet(featuresFile), readParquet(fillsFile)]);
  const { yes, no } = currentTokens(env, rawFeatures);
  const market = await lookupMarket(yes);

  const byToken: Record<string, FeaturePoint[]> = {};
  const spans = new Map<string, MarketSpan>();
  let lastTs = -Infinity;
  for (const r of rawFeatures) {
    const token = String(r.token_id);
    const ts = Number(r.ts);
    if (ts > lastTs) lastTs = ts;
    (byToken[token] ??= []).push({
      ts,
      bid: Number(r.best_bid),
      ask: Number(r.best_ask),
      mid: Number(r.midpoint),
      spread: Number(r.spread),
      imbalance: Number(r.book_imbalance),
      score: Number(r.score),
      volume: Number(r.trade_volume ?? 0) || 0,
    });
    if (!r.market) continue;
    const slug = String(r.market);
    const span = spans.get(slug) ?? { slug, yes: "", no: "", start: ts, end: ts };
    span.start = Math.min(span.start, ts);
    span.end = Math.max(span.end, ts);
    if (r.outcome === "YES") span.yes = token;
    if (r.outcome === "NO") span.no = token;
    spans.set(slug, span);
  }
  for (const token of Object.keys(byToken)) {
    byToken[token].sort((a, b) => a.ts - b.ts);
    byToken[token] = compact(byToken[token], lastTs - FULL_RES_SECONDS, MAX_OLD_POINTS_PER_TOKEN);
  }

  const fills = rawFills
    .map((r) => ({
      ts: Number(r.ts),
      token_id: String(r.token_id),
      side: String(r.side) as Fill["side"],
      size: Number(r.size),
      price: Number(r.price),
      fee: Number(r.fee ?? 0),
      order_id: String(r.order_id ?? ""),
      mode: String(r.mode ?? ""),
      reason: String(r.reason ?? ""),
      pnl: Number(r.pnl ?? 0),
      outcome: r.outcome ? String(r.outcome) : null,
    }))
    .sort((a, b) => a.ts - b.ts);

  return {
    market,
    tokens: { yes, no },
    config: {
      mode: env.PM_MODE || "paper",
      startingCash: Number(env.PM_PAPER_STARTING_CASH || 1000),
      signalThreshold: Number(env.PM_SIGNAL_THRESHOLD || 0.22),
      exitThreshold: Number(env.PM_EXIT_THRESHOLD || 0.04),
    },
    exportedAt: exportedAtOf(featuresFile),
    totalFeatureRows: rawFeatures.length,
    features: byToken,
    markets: [...spans.values()].sort((a, b) => a.start - b.start),
    fills,
  };
}
