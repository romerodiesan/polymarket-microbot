import "server-only";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT, activeTokens, lookupMarket, parquetPaths, readEnvFile } from "./data";
import { FEATURE_COLUMNS, type FeatureIndex, type FeatureStore, featureIndex, featureStore, fillsStore } from "./store";

export { FEATURE_COLUMNS };

const SESSION_GAP_SECONDS = 60;
const MAX_BUCKETS = 720;
const MIN_TRAINING_ROWS = 1000;
const DEFAULT_HORIZON_SECONDS = 15;
const DEFAULT_MIN_MOVE = 0.002;
const RECENT_ROWS = 50;

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

/** Welford's running mean and variance. */
class Moments {
  n = 0;
  mean = 0;
  m2 = 0;
  min = Infinity;
  max = -Infinity;

  add(v: number) {
    this.n++;
    const delta = v - this.mean;
    this.mean += delta / this.n;
    this.m2 += delta * (v - this.mean);
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }

  stat(name: string): FeatureStat {
    if (!this.n) return { name, mean: NaN, std: NaN, min: NaN, max: NaN };
    return { name, mean: this.mean, std: Math.sqrt(this.m2 / this.n), min: this.min, max: this.max };
  }
}

class Counter {
  counts = new Map<number, number>();
  min = Infinity;
  max = -Infinity;

  add(key: number) {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    if (key < this.min) this.min = key;
    if (key > this.max) this.max = key;
  }

  /**
   * The last MAX_BUCKETS buckets, chronological. Buckets without rows between the first and last one
   * are included with 0 so periods with the bot stopped show up as gaps.
   */
  buckets(next: (bucket: number) => number, step?: number): RowBucket[] {
    if (!this.counts.size) return [];
    const out: RowBucket[] = [];
    const start = step ? Math.max(this.min, this.max - (MAX_BUCKETS - 1) * step) : this.min;
    for (let ts = start; ts <= this.max; ts = next(ts)) out.push({ ts, rows: this.counts.get(ts) ?? 0 });
    return out.slice(-MAX_BUCKETS);
  }
}

function nextLocalDay(ts: number) {
  const d = new Date(ts * 1000);
  d.setDate(d.getDate() + 1);
  return d.getTime() / 1000;
}

type TokenAgg = { spread: Moments; score: Moments; minMid: number; maxMid: number };

/**
 * Labelling of microbot-train with its defaults: the first midpoint at least `h` seconds later
 * (within another `h`), counted only if it beats spread/2 + min_move. `i` is the next row awaiting a
 * label; it stays put until a row past its horizon arrives.
 */
type LabelState = { epoch: number; i: number; j: number; ups: number; downs: number };

/** Everything /data shows, kept up to date one appended row at a time. */
class CollectionAggregates {
  version = "";
  processed = 0;
  tokens = new Map<number, TokenAgg>();
  sessions: Session[] = [];
  minute = new Counter();
  hour = new Counter();
  day = new Counter();
  features = FEATURE_COLUMNS.map(() => new Moments());
  usable = 0;
  labels = new Map<number, LabelState>();
  private dayStart = NaN;
  private dayEnd = NaN;

  update(store: FeatureStore, index: FeatureIndex) {
    if (this.version !== store.version) {
      Object.assign(this, new CollectionAggregates());
      this.version = store.version;
    }
    if (this.processed === store.count) return;
    const { ts, midpoint, spread, score } = store.num;
    const token = store.code.token_id;
    const columns = FEATURE_COLUMNS.map((c) => store.num[c]);

    for (let i = this.processed; i < store.count; i++) {
      const t = ts[i];
      let agg = this.tokens.get(token[i]);
      if (!agg) {
        agg = { spread: new Moments(), score: new Moments(), minMid: Infinity, maxMid: -Infinity };
        this.tokens.set(token[i], agg);
      }
      if (Number.isFinite(spread[i])) agg.spread.add(spread[i]);
      if (Number.isFinite(score[i])) agg.score.add(score[i]);
      if (midpoint[i] < agg.minMid) agg.minMid = midpoint[i];
      if (midpoint[i] > agg.maxMid) agg.maxMid = midpoint[i];

      const session = this.sessions.at(-1);
      if (session && t - session.end <= SESSION_GAP_SECONDS) {
        if (t > session.end) session.end = t;
        session.rows++;
      } else {
        this.sessions.push({ start: t, end: t, rows: 1 });
      }

      this.minute.add(Math.floor(t / 60) * 60);
      this.hour.add(Math.floor(t / 3600) * 3600);
      if (!(t >= this.dayStart && t < this.dayEnd)) {
        // Local midnight, so days match the calendar of the machine running the dashboard.
        this.dayStart = new Date(t * 1000).setHours(0, 0, 0, 0) / 1000;
        this.dayEnd = nextLocalDay(this.dayStart);
      }
      this.day.add(this.dayStart);

      let complete = true;
      for (let c = 0; c < columns.length; c++) {
        const v = columns[c][i];
        if (Number.isFinite(v)) this.features[c].add(v);
        else complete = false;
      }
      if (complete) this.usable++;
    }
    this.processed = store.count;
    this.advanceLabels(store, index, columns);
  }

  private advanceLabels(store: FeatureStore, index: FeatureIndex, columns: Float64Array[]) {
    const { ts, midpoint, spread } = store.num;
    const h = DEFAULT_HORIZON_SECONDS;
    const complete = (row: number) => columns.every((c) => Number.isFinite(c[row]));
    for (const [tok, rows] of index.tokens) {
      let state = this.labels.get(tok);
      if (!state || state.epoch !== rows.epoch) {
        state = { epoch: rows.epoch, i: 0, j: 0, ups: 0, downs: 0 };
        this.labels.set(tok, state);
      }
      const list = rows.list.view();
      const n = list.length;
      let { i, j } = state;
      for (; i < n; i++) {
        const row = list[i];
        if (!complete(row)) continue;
        const target = ts[row] + h;
        while (j < n && ts[list[j]] < target) j++;
        if (j >= n) break;
        if (ts[list[j]] - target > h) continue;
        const move = midpoint[list[j]] - midpoint[row];
        if (Math.abs(move) <= spread[row] / 2 + DEFAULT_MIN_MOVE) continue;
        if (move > 0) state.ups++;
        else state.downs++;
      }
      state.i = i;
      state.j = j;
    }
  }
}

const aggregates = new WeakMap<FeatureStore, CollectionAggregates>();

export async function loadCollection(): Promise<CollectionData> {
  const env = readEnvFile();
  const dbPath = path.resolve(/*turbopackIgnore: true*/ ROOT, env.PM_DB_PATH || "data/microbot.duckdb");
  const { featuresFile, fillsFile } = parquetPaths(env);
  const [store, fills] = await Promise.all([featureStore(featuresFile), fillsStore(fillsFile)]);
  const index = featureIndex(store);
  let agg = aggregates.get(store);
  if (!agg) {
    agg = new CollectionAggregates();
    aggregates.set(store, agg);
  }
  agg.update(store, index);

  const active = activeTokens(env, store, index);
  const market = await lookupMarket(active.yes);
  const labels: Record<string, string> = { [active.yes]: "YES", [active.no]: "NO" };
  const labelOf = (row: number) => store.str("outcome", row) ?? labels[store.str("token_id", row) ?? ""];
  const { ts, midpoint } = store.num;

  const tokens: TokenSummary[] = [];
  let first = Infinity;
  let last = -Infinity;
  for (const [tok, rows] of index.tokens) {
    const list = rows.list.view();
    const firstRow = list[0];
    const lastRow = list[list.length - 1];
    const id = store.dict.token_id[tok] ?? "";
    const a = agg.tokens.get(tok)!;
    first = Math.min(first, ts[firstRow]);
    last = Math.max(last, ts[lastRow]);
    tokens.push({
      token: id,
      label: labelOf(firstRow) ?? id.slice(0, 10),
      market: store.str("market", firstRow),
      rows: list.length,
      first: ts[firstRow],
      last: ts[lastRow],
      avgSpread: a.spread.n ? a.spread.mean : NaN,
      avgScore: a.score.n ? a.score.mean : NaN,
      minMid: a.minMid,
      maxMid: a.maxMid,
      lastMid: midpoint[lastRow],
    });
  }
  tokens.sort((a, b) => b.last - a.last);

  let ups = 0;
  let downs = 0;
  for (const state of agg.labels.values()) {
    ups += state.ups;
    downs += state.downs;
  }

  const recentRows: number[] = [];
  for (let i = Math.max(0, store.count - RECENT_ROWS); i < store.count; i++) recentRows.push(i);
  recentRows.sort((a, b) => ts[b] - ts[a] || b - a);
  const recent = recentRows.map((row) => {
    const out: Row = {};
    for (const c of store.spec.numeric) out[c] = store.num[c][row];
    for (const c of store.spec.strings) out[c] = store.str(c, row) ?? "";
    out.token_id = labelOf(row) ?? String(out.token_id);
    return out;
  });

  const featuresInfo = fileInfo(featuresFile);
  return {
    market,
    totalRows: store.count,
    totalFills: fills.count,
    first: store.count ? first : null,
    last: store.count ? last : null,
    exportedAt: featuresInfo?.modifiedAt ?? null,
    tokens,
    sessions: agg.sessions.slice().reverse(),
    rowsOverTime: {
      minute: agg.minute.buckets((b) => b + 60, 60),
      hour: agg.hour.buckets((b) => b + 3600, 3600),
      day: agg.day.buckets(nextLocalDay),
    },
    featureStats: FEATURE_COLUMNS.map((name, c) => agg.features[c].stat(name)),
    training: {
      minRows: MIN_TRAINING_ROWS,
      ready: agg.usable >= MIN_TRAINING_ROWS && ups > 0 && downs > 0,
      horizonSeconds: DEFAULT_HORIZON_SECONDS,
      minMove: DEFAULT_MIN_MOVE,
      usable: agg.usable,
      labelled: ups + downs,
      ups,
      downs,
    },
    files: [dbPath, `${dbPath}.wal`, featuresFile, fillsFile].map(fileInfo),
    recent,
  };
}
