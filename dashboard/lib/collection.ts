import "server-only";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT, lookupMarket, readEnvFile, readParquet } from "./data";

/** Same order as FEATURE_COLUMNS in src/microbot/model.py. */
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

const SESSION_GAP_SECONDS = 60;
const MAX_MINUTE_BUCKETS = 720;
const MIN_TRAINING_ROWS = 1000;
const DEFAULT_HORIZON_SECONDS = 15;
const DEFAULT_MIN_MOVE = 0.002;

type Row = Record<string, number | string>;

export type TokenSummary = {
  token: string;
  label: string;
  rows: number;
  first: number;
  last: number;
  avgSpread: number;
  avgScore: number;
  minMid: number;
  maxMid: number;
  lastMid: number;
};

export type Session = { start: number; end: number; rows: number };

export type FeatureStat = { name: string; mean: number; std: number; min: number; max: number };

export type FileInfo = { name: string; bytes: number; modifiedAt: number } | null;

export type CollectionData = {
  market: { question: string | null; url: string | null };
  totalRows: number;
  totalFills: number;
  first: number | null;
  last: number | null;
  exportedAt: number | null;
  tokens: TokenSummary[];
  sessions: Session[];
  perMinute: { ts: number; rows: number }[];
  featureStats: FeatureStat[];
  training: {
    minRows: number;
    ready: boolean;
    horizonSeconds: number;
    minMove: number;
    usable: number;
    labelled: number;
    ups: number;
    downs: number;
  };
  files: FileInfo[];
  recent: Row[];
};

function fileInfo(file: string): FileInfo {
  if (!existsSync(file)) return null;
  const s = statSync(file);
  return { name: path.relative(ROOT, file), bytes: s.size, modifiedAt: s.mtimeMs / 1000 };
}

function stats(values: number[]): Omit<FeatureStat, "name"> {
  if (!values.length) return { mean: NaN, std: NaN, min: NaN, max: NaN };
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) ** 2;
  return { mean, std: Math.sqrt(sq / values.length), min, max };
}

export async function loadCollection(): Promise<CollectionData> {
  const env = readEnvFile();
  const dbPath = path.resolve(/*turbopackIgnore: true*/ ROOT, env.PM_DB_PATH || "data/microbot.duckdb");
  const parquetDir = path.resolve(/*turbopackIgnore: true*/ ROOT, env.PM_PARQUET_DIR || "data/parquet");
  const featuresFile = path.join(parquetDir, "features.parquet");
  const fillsFile = path.join(parquetDir, "fills.parquet");
  const labels: Record<string, string> = {
    [env.PM_YES_TOKEN_ID ?? ""]: "YES",
    [env.PM_NO_TOKEN_ID ?? ""]: "NO",
  };

  const [rawRows, fills, market] = await Promise.all([
    readParquet(featuresFile),
    readParquet(fillsFile),
    lookupMarket(env.PM_YES_TOKEN_ID ?? ""),
  ]);
  const rows = (rawRows as Row[])
    .map((r): Row & { ts: number } => ({ ...r, ts: Number(r.ts), token_id: String(r.token_id) }))
    .sort((a, b) => a.ts - b.ts);

  const byToken = new Map<string, Row[]>();
  for (const r of rows) {
    const token = String(r.token_id);
    if (!byToken.has(token)) byToken.set(token, []);
    byToken.get(token)!.push(r);
  }

  const tokens: TokenSummary[] = [...byToken.entries()].map(([token, list]) => {
    const mids = list.map((r) => Number(r.midpoint));
    return {
      token,
      label: labels[token] ?? token.slice(0, 10),
      rows: list.length,
      first: Number(list[0].ts),
      last: Number(list.at(-1)!.ts),
      avgSpread: stats(list.map((r) => Number(r.spread))).mean,
      avgScore: stats(list.map((r) => Number(r.score))).mean,
      minMid: Math.min(...mids),
      maxMid: Math.max(...mids),
      lastMid: mids.at(-1)!,
    };
  });

  const sessions: Session[] = [];
  for (const r of rows) {
    const ts = Number(r.ts);
    const current = sessions.at(-1);
    if (current && ts - current.end <= SESSION_GAP_SECONDS) {
      current.end = ts;
      current.rows++;
    } else {
      sessions.push({ start: ts, end: ts, rows: 1 });
    }
  }

  const buckets = new Map<number, number>();
  for (const r of rows) {
    const minute = Math.floor(Number(r.ts) / 60) * 60;
    buckets.set(minute, (buckets.get(minute) ?? 0) + 1);
  }
  const perMinute = [...buckets.entries()]
    .map(([ts, count]) => ({ ts, rows: count }))
    .slice(-MAX_MINUTE_BUCKETS);

  const featureStats = FEATURE_COLUMNS.map((name) => ({
    name,
    ...stats(rows.map((r) => Number(r[name])).filter(Number.isFinite)),
  }));

  // Same labelling as microbot-train with its defaults: the first midpoint at least
  // `h` seconds later (within another `h`), counted only if it beats spread/2 + min_move.
  const h = DEFAULT_HORIZON_SECONDS;
  const hasFeatures = (r: Row) => FEATURE_COLUMNS.every((c) => r[c] != null && Number.isFinite(Number(r[c])));
  let usable = 0;
  let ups = 0;
  let downs = 0;
  for (const list of byToken.values()) {
    let j = 0;
    for (let i = 0; i < list.length; i++) {
      if (!hasFeatures(list[i])) continue;
      usable++;
      const target = Number(list[i].ts) + h;
      while (j < list.length && Number(list[j].ts) < target) j++;
      if (j >= list.length) break;
      if (Number(list[j].ts) - target > h) continue;
      const move = Number(list[j].midpoint) - Number(list[i].midpoint);
      if (Math.abs(move) <= Number(list[i].spread) / 2 + DEFAULT_MIN_MOVE) continue;
      if (move > 0) ups++;
      else downs++;
    }
  }

  const featuresInfo = fileInfo(featuresFile);
  return {
    market,
    totalRows: rows.length,
    totalFills: fills.length,
    first: rows[0]?.ts ?? null,
    last: rows.at(-1)?.ts ?? null,
    exportedAt: featuresInfo?.modifiedAt ?? null,
    tokens,
    sessions: sessions.reverse(),
    perMinute,
    featureStats,
    training: {
      minRows: MIN_TRAINING_ROWS,
      ready: usable >= MIN_TRAINING_ROWS && ups > 0 && downs > 0,
      horizonSeconds: DEFAULT_HORIZON_SECONDS,
      minMove: DEFAULT_MIN_MOVE,
      usable,
      labelled: ups + downs,
      ups,
      downs,
    },
    files: [dbPath, `${dbPath}.wal`, featuresFile, fillsFile].map(fileInfo),
    recent: rows.slice(-50).reverse().map((r) => ({ ...r, token_id: labels[String(r.token_id)] ?? String(r.token_id) })),
  };
}
