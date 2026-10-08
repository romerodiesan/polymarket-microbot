import "server-only";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";

export const ROOT = path.resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.MICROBOT_ROOT ?? "..");
const MAX_POINTS_PER_TOKEN = 3000;

export type FeaturePoint = {
  ts: number;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  imbalance: number;
  score: number;
};

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
  fills: Fill[];
};

export function readEnvFile(): Record<string, string> {
  const file = path.join(/*turbopackIgnore: true*/ ROOT, ".env");
  if (!existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

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

function downsample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(rows[Math.floor(i * step)]);
  out.push(rows[rows.length - 1]);
  return out;
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

export async function loadBotData(): Promise<BotData> {
  const env = readEnvFile();
  const parquetDir = path.resolve(/*turbopackIgnore: true*/ ROOT, env.PM_PARQUET_DIR || "data/parquet");
  const featuresFile = path.join(parquetDir, "features.parquet");
  const fillsFile = path.join(parquetDir, "fills.parquet");
  const yes = env.PM_YES_TOKEN_ID ?? "";
  const no = env.PM_NO_TOKEN_ID ?? "";

  const [rawFeatures, rawFills, market] = await Promise.all([
    readParquet(featuresFile),
    readParquet(fillsFile),
    lookupMarket(yes),
  ]);

  const byToken: Record<string, FeaturePoint[]> = {};
  for (const r of rawFeatures) {
    const token = String(r.token_id);
    (byToken[token] ??= []).push({
      ts: Number(r.ts),
      bid: Number(r.best_bid),
      ask: Number(r.best_ask),
      mid: Number(r.midpoint),
      spread: Number(r.spread),
      imbalance: Number(r.book_imbalance),
      score: Number(r.score),
    });
  }
  for (const token of Object.keys(byToken)) {
    byToken[token].sort((a, b) => a.ts - b.ts);
    byToken[token] = downsample(byToken[token], MAX_POINTS_PER_TOKEN);
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
    exportedAt: existsSync(featuresFile) ? statSync(featuresFile).mtimeMs / 1000 : null,
    totalFeatureRows: rawFeatures.length,
    features: byToken,
    fills,
  };
}
