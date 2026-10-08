import "server-only";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT, currentTokens, lookupMarket, readEnvFile, readParquet } from "./data";

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
const MAX_BUCKETS = 720;
const MIN_TRAINING_ROWS = 1000;
const DEFAULT_HORIZON_SECONDS = 15;
const DEFAULT_MIN_MOVE = 0.002;

type Row = Record<string, number | string>;

export type TokenSummary = {
  token: string;
  label: string;
  market: string | null;
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

export type Resolution = "minute" | "hour" | "day";

export type RowBucket = { ts: number; rows: number };

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
  rowsOverTime: Record<Resolution, RowBucket[]>;
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

/**
 * Rows per bucket, chronological (rows are sorted by ts). Buckets without rows between the first
 * and last one are included with 0 so periods with the bot stopped show up as gaps.
 */
function countRows(rows: Row[], bucketOf: (ts: number) => number, next: (bucket: number) => number): RowBucket[] {
  const buckets = new Map<number, number>();
  for (const r of rows) {
    const key = bucketOf(Number(r.ts));
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const keys = [...buckets.keys()];
  if (!keys.length) return [];
  const out: RowBucket[] = [];
  for (let ts = keys[0]; ts <= keys[keys.length - 1]; ts = next(ts)) out.push({ ts, rows: buckets.get(ts) ?? 0 });
  return out.slice(-MAX_BUCKETS);
}

function nextLocalDay(ts: number) {
  const d = new Date(ts * 1000);
  d.setDate(d.getDate() + 1);
  return d.getTime() / 1000;
}

export async function loadCollection(): Promise<CollectionData> {
  const env = readEnvFile();
  const dbPath = path.resolve(/*turbopackIgnore: true*/ ROOT, env.PM_DB_PATH || "data/microbot.duckdb");
  const parquetDir = path.resolve(/*turbopackIgnore: true*/ ROOT, env.PM_PARQUET_DIR || "data/parquet");
  const featuresFile = path.join(parquetDir, "features.parquet");
  const fillsFile = path.join(parquetDir, "fills.parquet");
  const [rawRows, fills] = await Promise.all([readParquet(featuresFile), readParquet(fillsFile)]);
  const active = currentTokens(env, rawRows);
  const market = await lookupMarket(active.yes);
  const labels: Record<string, string> = { [active.yes]: "YES", [active.no]: "NO" };
  const labelOf = (r: Row) => (r.outcome ? String(r.outcome) : labels[String(r.token_id)]);
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
      label: labelOf(list[0]) ?? token.slice(0, 10),
      market: list[0].market ? String(list[0].market) : null,
      rows: list.length,
      first: Number(list[0].ts),
      last: Number(list.at(-1)!.ts),
      avgSpread: stats(list.map((r) => Number(r.spread))).mean,
      avgScore: stats(list.map((r) => Number(r.score))).mean,
      minMid: Math.min(...mids),
      maxMid: Math.max(...mids),
      lastMid: mids.at(-1)!,
    };
  }).sort((a, b) => b.last - a.last);

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

  const rowsOverTime: Record<Resolution, RowBucket[]> = {
    minute: countRows(rows, (ts) => Math.floor(ts / 60) * 60, (b) => b + 60),
    hour: countRows(rows, (ts) => Math.floor(ts / 3600) * 3600, (b) => b + 3600),
    // Local midnight, so days match the calendar of the machine running the bot.
    day: countRows(rows, (ts) => new Date(ts * 1000).setHours(0, 0, 0, 0) / 1000, nextLocalDay),
  };

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
    rowsOverTime,
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
    recent: rows.slice(-50).reverse().map((r) => ({ ...r, token_id: labelOf(r) ?? String(r.token_id) })),
  };
}
