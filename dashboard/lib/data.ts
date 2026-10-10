import "server-only";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT, readEnvFile } from "./env";
import {
  type FeatureIndex,
  type FeatureStore,
  type FillsStore,
  featureIndex,
  featureStore,
  fillsStore,
  lastAtOrBefore,
  readTable,
} from "./store";

export { ROOT, readEnvFile };
/** Most recent span sent at full resolution on a full load; older history is merged per token. */
const FULL_RES_SECONDS = 2 * 3600;
const MAX_OLD_POINTS_PER_TOKEN = 600;
/** Merge steps for old history, aligned to the clock so the merged points never shift between loads. */
const MERGE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 86400];

/** One token's samples as parallel columns; null where the bot recorded no value. */
export type SeriesColumns = {
  ts: number[];
  bid: (number | null)[];
  ask: (number | null)[];
  mid: (number | null)[];
  spread: (number | null)[];
  imbalance: (number | null)[];
  score: (number | null)[];
  /** Shares traded since the previous sample (0 for rows recorded before volume existed). */
  volume: number[];
};

export const SERIES_FIELDS = ["ts", "bid", "ask", "mid", "spread", "imbalance", "score", "volume"] as const;

export type FillColumns = {
  ts: number[];
  token_id: string[];
  side: string[];
  size: number[];
  price: number[];
  fee: number[];
  order_id: string[];
  mode: string[];
  reason: string[];
  pnl: number[];
  /** YES/NO side within its market; null for fills recorded before markets were tagged. */
  outcome: (string | null)[];
};

export const ORDER_COLUMNS = [
  "order_id", "market", "token_id", "outcome", "side", "reason", "status", "reject_reason",
  "submit_ts", "done_ts", "latency_ms", "requested_size", "limit_price", "filled_size", "avg_price",
  "fee", "fee_rate", "fee_source", "slippage_vs_mid", "slippage_vs_touch", "decision_mid", "exec_mid",
] as const;

/** One order intent and how it executed (`orders` table); null where not recorded. */
export type OrderRow = {
  order_id: string;
  market: string | null;
  token_id: string;
  outcome: string | null;
  side: string;
  reason: string | null;
  status: string | null;
  reject_reason: string | null;
  submit_ts: number;
  done_ts: number | null;
  latency_ms: number | null;
  requested_size: number | null;
  limit_price: number | null;
  filled_size: number | null;
  avg_price: number | null;
  fee: number | null;
  fee_rate: number | null;
  fee_source: string | null;
  slippage_vs_mid: number | null;
  slippage_vs_touch: number | null;
  decision_mid: number | null;
  exec_mid: number | null;
};

const MARKET_COLUMNS = [
  "slug", "resolved", "winner", "payout_yes", "payout_no", "resolved_ts", "btc_open", "btc_close",
  "btc_source", "fee_rate", "fee_source", "end_ts",
] as const;

/** Official outcome and costs of a market (`markets` table). */
export type MarketResolution = {
  slug: string;
  resolved: boolean;
  winner: string | null;
  payoutYes: number | null;
  payoutNo: number | null;
  resolvedTs: number | null;
  btcOpen: number | null;
  btcClose: number | null;
  btcSource: string | null;
  feeRate: number | null;
  feeSource: string | null;
  endTs: number | null;
};

/** One market of a rolling series, as recorded (start/end are the first and last rows). */
export type MarketSpan = { slug: string; yes: string; no: string; start: number; end: number };

export type BotMeta = {
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
  /** Chronological; empty when the rows carry no market. */
  markets: MarketSpan[];
};

/**
 * Either everything (`reset`) or the rows appended since the client's cursors. `features` and
 * `fills` hold only the new samples in a delta; the client appends them.
 */
export type LivePayload = BotMeta & {
  version: string;
  reset: boolean;
  cursor: number;
  fillsCursor: number;
  features: Record<string, SeriesColumns>;
  fills: FillColumns;
  ordersCursor: number;
  /** Orders appended since the client's cursor (all of them on a reset). */
  orders: OrderRow[];
  resolutionsKey: string;
  /** Every market's resolution, or null when unchanged since the client's key. */
  resolutions: Record<string, MarketResolution> | null;
};

export type LiveRequest = {
  version?: string | null;
  since?: number;
  fillsSince?: number;
  ordersSince?: number;
  resolutionsKey?: string | null;
};

/** Failed lookups are retried after this long instead of on every poll. */
const LOOKUP_RETRY_MS = 60_000;
const marketCache = new Map<string, { info: BotMeta["market"]; until: number }>();

export async function lookupMarket(tokenId: string): Promise<BotMeta["market"]> {
  if (!tokenId) return { question: null, url: null };
  const cached = marketCache.get(tokenId);
  if (cached && Date.now() < cached.until) return cached.info;
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
    marketCache.set(tokenId, { info, until: Infinity });
    return info;
  } catch {
    const info = { question: null, url: null };
    marketCache.set(tokenId, { info, until: Date.now() + LOOKUP_RETRY_MS });
    return info;
  }
}

/** Fixed tokens from .env, or with PM_SERIES_SLUG the YES/NO tokens of the latest recorded market. */
export function activeTokens(env: Record<string, string>, store: FeatureStore, index: FeatureIndex) {
  const fixed = { yes: env.PM_YES_TOKEN_ID ?? "", no: env.PM_NO_TOKEN_ID ?? "" };
  if (!env.PM_SERIES_SLUG || index.latest < 0) return fixed;
  const span = index.spans.get(store.code.market[index.latest]);
  if (!span) return fixed;
  const id = (code: number) => (code < 0 ? "" : store.dict.token_id[code]);
  return { yes: id(span.yes), no: id(span.no) };
}

export function parquetPaths(env: Record<string, string>) {
  const parquetDir = path.resolve(/*turbopackIgnore: true*/ ROOT, env.PM_PARQUET_DIR || "data/parquet");
  return {
    parquetDir,
    featuresFile: path.join(parquetDir, "features.parquet"),
    fillsFile: path.join(parquetDir, "fills.parquet"),
    table: (name: string) => path.join(parquetDir, `${name}.parquet`),
  };
}

const exportedAtOf = (file: string) => (existsSync(file) ? statSync(file).mtimeMs / 1000 : null);

export type BotStatus = { mode: string; exportedAt: number | null };

/** Cheap enough to poll from every page: no Parquet reads. */
export function loadBotStatus(): BotStatus {
  const env = readEnvFile();
  return { mode: env.PM_MODE || "paper", exportedAt: exportedAtOf(parquetPaths(env).featuresFile) };
}

const round = (x: number, scale: number) => (Number.isFinite(x) ? Math.round(x * scale) / scale : null);

function emptySeries(): SeriesColumns {
  return { ts: [], bid: [], ask: [], mid: [], spread: [], imbalance: [], score: [], volume: [] };
}

function pushRow(out: SeriesColumns, store: FeatureStore, row: number, volume: number) {
  const n = store.num;
  out.ts.push(round(n.ts[row], 1e3) ?? 0);
  out.bid.push(round(n.best_bid[row], 1e6));
  out.ask.push(round(n.best_ask[row], 1e6));
  out.mid.push(round(n.midpoint[row], 1e6));
  out.spread.push(round(n.spread[row], 1e6));
  out.imbalance.push(round(n.book_imbalance[row], 1e6));
  out.score.push(round(n.score[row], 1e6));
  out.volume.push(round(volume, 1e6) ?? 0);
}

const volumeAt = (store: FeatureStore, row: number) => {
  const v = store.num.trade_volume[row];
  return Number.isFinite(v) ? v : 0;
};

/**
 * A token's full history: the last FULL_RES_SECONDS as recorded, older rows merged into clock-aligned
 * buckets (last values of the bucket, summed volume) so there are at most ~MAX_OLD_POINTS_PER_TOKEN.
 */
function fullSeries(store: FeatureStore, rows: Int32Array, cutoff: number): SeriesColumns {
  const ts = store.num.ts;
  const out = emptySeries();
  const split = lastAtOrBefore(rows.length, (i) => ts[rows[i]], cutoff - 1e-9) + 1;
  let start = 0;
  if (split > MAX_OLD_POINTS_PER_TOKEN) {
    const span = ts[rows[split - 1]] - ts[rows[0]];
    const step = MERGE_STEPS.find((s) => span / s <= MAX_OLD_POINTS_PER_TOKEN) ?? MERGE_STEPS[MERGE_STEPS.length - 1];
    let bucket = Math.floor(ts[rows[0]] / step);
    let volume = 0;
    for (let i = 0; i < split; i++) {
      const row = rows[i];
      const b = Math.floor(ts[row] / step);
      if (b !== bucket) {
        pushRow(out, store, rows[i - 1], volume);
        bucket = b;
        volume = 0;
      }
      volume += volumeAt(store, row);
    }
    pushRow(out, store, rows[split - 1], volume);
    start = split;
  }
  for (let i = start; i < rows.length; i++) pushRow(out, store, rows[i], volumeAt(store, rows[i]));
  return out;
}

function fillColumns(fills: FillsStore, from: number): FillColumns {
  const out: FillColumns = {
    ts: [], token_id: [], side: [], size: [], price: [], fee: [], order_id: [], mode: [], reason: [], pnl: [], outcome: [],
  };
  const n = fills.num;
  for (let i = from; i < fills.count; i++) {
    out.ts.push(round(n.ts[i], 1e3) ?? 0);
    out.token_id.push(fills.str("token_id", i) ?? "");
    out.side.push(fills.str("side", i) ?? "");
    out.size.push(round(n.size[i], 1e6) ?? 0);
    out.price.push(round(n.price[i], 1e6) ?? 0);
    out.fee.push(round(n.fee[i], 1e6) ?? 0);
    out.order_id.push(fills.str("order_id", i) ?? "");
    out.mode.push(fills.str("mode", i) ?? "");
    out.reason.push(fills.str("reason", i) ?? "");
    out.pnl.push(round(n.pnl[i], 1e6) ?? 0);
    out.outcome.push(fills.str("outcome", i));
  }
  return out;
}

let fullCache: { key: string; features: Record<string, SeriesColumns> } | null = null;

function allFeatures(store: FeatureStore, index: FeatureIndex): Record<string, SeriesColumns> {
  const key = `${store.version}:${store.count}`;
  if (fullCache?.key === key) return fullCache.features;
  const cutoff = index.latest < 0 ? 0 : store.num.ts[index.latest] - FULL_RES_SECONDS;
  const features: Record<string, SeriesColumns> = {};
  for (const [tok, rows] of index.tokens) features[store.dict.token_id[tok]] = fullSeries(store, rows.list.view(), cutoff);
  fullCache = { key, features };
  return features;
}

function newFeatures(store: FeatureStore, from: number): Record<string, SeriesColumns> {
  const features: Record<string, SeriesColumns> = {};
  for (let row = from; row < store.count; row++) {
    const id = store.str("token_id", row) ?? "";
    pushRow((features[id] ??= emptySeries()), store, row, volumeAt(store, row));
  }
  return features;
}

const str = (v: unknown) => (v == null ? null : String(v));
const numOrNull = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

export async function loadOrders(env: Record<string, string>): Promise<OrderRow[]> {
  const rows = await readTable(parquetPaths(env).table("orders"), ORDER_COLUMNS);
  return rows.map((r) => ({
    order_id: String(r.order_id ?? ""),
    market: str(r.market),
    token_id: String(r.token_id ?? ""),
    outcome: str(r.outcome),
    side: String(r.side ?? ""),
    reason: str(r.reason),
    status: str(r.status),
    reject_reason: str(r.reject_reason),
    submit_ts: Number(r.submit_ts ?? 0),
    done_ts: numOrNull(r.done_ts),
    latency_ms: numOrNull(r.latency_ms),
    requested_size: numOrNull(r.requested_size),
    limit_price: numOrNull(r.limit_price),
    filled_size: numOrNull(r.filled_size),
    avg_price: numOrNull(r.avg_price),
    fee: numOrNull(r.fee),
    fee_rate: numOrNull(r.fee_rate),
    fee_source: str(r.fee_source),
    slippage_vs_mid: numOrNull(r.slippage_vs_mid),
    slippage_vs_touch: numOrNull(r.slippage_vs_touch),
    decision_mid: numOrNull(r.decision_mid),
    exec_mid: numOrNull(r.exec_mid),
  }));
}

export async function loadResolutions(env: Record<string, string>) {
  const file = parquetPaths(env).table("markets");
  const rows = await readTable(file, MARKET_COLUMNS);
  const key = existsSync(file) ? String(statSync(file).mtimeMs) : "";
  const resolutions: Record<string, MarketResolution> = {};
  for (const r of rows) {
    if (!r.slug) continue;
    resolutions[String(r.slug)] = {
      slug: String(r.slug),
      resolved: Boolean(r.resolved),
      winner: str(r.winner),
      payoutYes: numOrNull(r.payout_yes),
      payoutNo: numOrNull(r.payout_no),
      resolvedTs: numOrNull(r.resolved_ts),
      btcOpen: numOrNull(r.btc_open),
      btcClose: numOrNull(r.btc_close),
      btcSource: str(r.btc_source),
      feeRate: numOrNull(r.fee_rate),
      feeSource: str(r.fee_source),
      endTs: numOrNull(r.end_ts),
    };
  }
  return { key, resolutions };
}

/** `null` when nothing changed since the client's cursors (the route answers 304). */
export async function loadLiveData(request: LiveRequest = {}): Promise<LivePayload | null> {
  const env = readEnvFile();
  const { featuresFile, fillsFile } = parquetPaths(env);
  const [store, fills, orders, markets] = await Promise.all([
    featureStore(featuresFile),
    fillsStore(fillsFile),
    loadOrders(env),
    loadResolutions(env),
  ]);
  const index = featureIndex(store);
  const version = `${store.version}~${fills.version}`;
  const since = request.since ?? -1;
  const fillsSince = request.fillsSince ?? -1;
  const ordersSince = request.ordersSince ?? -1;
  const reset =
    request.version !== version ||
    since < 0 ||
    since > store.count ||
    fillsSince < 0 ||
    fillsSince > fills.count ||
    ordersSince < 0 ||
    ordersSince > orders.length;
  const resolutionsChanged = request.resolutionsKey !== markets.key;
  if (!reset && since === store.count && fillsSince === fills.count && ordersSince === orders.length && !resolutionsChanged) {
    return null;
  }

  const tokens = activeTokens(env, store, index);
  const name = (code: number) => (code < 0 ? "" : store.dict.token_id[code]);
  return {
    version,
    reset,
    cursor: store.count,
    fillsCursor: fills.count,
    market: await lookupMarket(tokens.yes),
    tokens,
    config: {
      mode: env.PM_MODE || "paper",
      startingCash: Number(env.PM_PAPER_STARTING_CASH || 1000),
      signalThreshold: Number(env.PM_SIGNAL_THRESHOLD || 0.22),
      exitThreshold: Number(env.PM_EXIT_THRESHOLD || 0.04),
    },
    exportedAt: exportedAtOf(featuresFile),
    totalFeatureRows: store.count,
    markets: index.markets().map((span) => ({
      slug: store.dict.market[span.market],
      yes: name(span.yes),
      no: name(span.no),
      start: span.start,
      end: span.end,
    })),
    features: reset ? allFeatures(store, index) : newFeatures(store, since),
    fills: fillColumns(fills, reset ? 0 : fillsSince),
    ordersCursor: orders.length,
    orders: orders.slice(reset ? 0 : ordersSince),
    resolutionsKey: markets.key,
    resolutions: reset || resolutionsChanged ? markets.resolutions : null,
  };
}
