/**
 * Equivalence of the incremental store/aggregates with a naive full recomputation.
 *
 *   npm run test:store
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";

const root = mkdtempSync(path.join(tmpdir(), "microbot-store-"));
process.env.MICROBOT_ROOT = root;
const python = path.resolve(__dirname, "../../bot/.bot/bin/python");
const fixture = (rows: number, append = 0) =>
  execFileSync(python, [path.join(__dirname, "make-fixture.py"), root, String(rows), "300", ...(append ? ["--append", String(append)] : [])]);
const features = path.join(root, "data/parquet/features.parquet");

const FEATURES = ["spread_ticks", "weighted_imbalance", "book_imbalance", "microprice_delta", "ofi", "flow_imbalance", "trade_pressure", "volatility"];
type Row = Record<string, number | string | null>;

/** The pre-store implementation of /data, over plain objects. */
function naive(rows: Row[]) {
  rows = rows.slice().sort((a, b) => Number(a.ts) - Number(b.ts));
  const byToken = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byToken.get(String(r.token_id)) ?? [];
    list.push(r);
    byToken.set(String(r.token_id), list);
  }
  const sessions: { start: number; end: number; rows: number }[] = [];
  for (const r of rows) {
    const ts = Number(r.ts);
    const s = sessions.at(-1);
    if (s && ts - s.end <= 60) {
      s.end = ts;
      s.rows++;
    } else sessions.push({ start: ts, end: ts, rows: 1 });
  }
  const minutes = new Map<number, number>();
  for (const r of rows) {
    const k = Math.floor(Number(r.ts) / 60) * 60;
    minutes.set(k, (minutes.get(k) ?? 0) + 1);
  }
  const stats = FEATURES.map((c) => {
    const v = rows.map((r) => Number(r[c])).filter(Number.isFinite);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    return { mean, std: Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length) };
  });
  let usable = 0;
  let ups = 0;
  let downs = 0;
  const complete = (r: Row) => FEATURES.every((c) => r[c] != null && Number.isFinite(Number(r[c])));
  for (const list of byToken.values()) {
    let j = 0;
    for (let i = 0; i < list.length; i++) {
      if (!complete(list[i])) continue;
      usable++;
      const target = Number(list[i].ts) + 15;
      while (j < list.length && Number(list[j].ts) < target) j++;
      if (j >= list.length) continue;
      if (Number(list[j].ts) - target > 15) continue;
      const move = Number(list[j].midpoint) - Number(list[i].midpoint);
      if (Math.abs(move) <= Number(list[i].spread) / 2 + 0.002) continue;
      if (move > 0) ups++;
      else downs++;
    }
  }
  return { byToken, sessions, minutes, stats, usable, ups, downs };
}

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${a} ≠ ${b}`);

async function check(label: string) {
  const { loadCollection } = await import("../lib/collection");
  const rows = (await parquetReadObjects({ file: await asyncBufferFromFile(features) })) as Row[];
  const ref = naive(rows);
  const got = await loadCollection();

  assert.equal(got.totalRows, rows.length);
  assert.equal(got.tokens.length, ref.byToken.size);
  for (const t of got.tokens) {
    const list = ref.byToken.get(t.token)!;
    assert.equal(t.rows, list.length);
    assert.equal(t.first, Number(list[0].ts));
    assert.equal(t.last, Number(list.at(-1)!.ts));
    assert.equal(t.lastMid, Number(list.at(-1)!.midpoint));
    close(t.avgSpread, list.reduce((a, r) => a + Number(r.spread), 0) / list.length);
  }
  assert.deepEqual(got.sessions.slice().reverse(), ref.sessions);
  const minutes = [...ref.minutes.keys()];
  const last = minutes.at(-1)!;
  for (const b of got.rowsOverTime.minute) assert.equal(b.rows, ref.minutes.get(b.ts) ?? 0);
  assert.equal(got.rowsOverTime.minute.at(-1)!.ts, last);
  got.featureStats.forEach((s, i) => {
    close(s.mean, ref.stats[i].mean);
    close(s.std, ref.stats[i].std);
  });
  assert.equal(got.training.usable, ref.usable);
  assert.equal(got.training.ups, ref.ups);
  assert.equal(got.training.downs, ref.downs);
  console.log(`ok ${label}: ${rows.length} rows, ${got.tokens.length} tokens, ${ref.ups}/${ref.downs} labels`);
}

async function checkDeltas() {
  const { loadLiveData } = await import("../lib/data");
  fixture(30000);
  const full = (await loadLiveData())!;
  assert.equal(full.reset, true);
  assert.equal(await loadLiveData({ version: full.version, since: full.cursor, fillsSince: full.fillsCursor }), null);

  fixture(30000, 777);
  const delta = (await loadLiveData({ version: full.version, since: full.cursor, fillsSince: full.fillsCursor }))!;
  assert.equal(delta.reset, false);
  assert.equal(delta.cursor, 30777);
  assert.equal(Object.values(delta.features).reduce((a, s) => a + s.ts.length, 0), 777);

  const fresh = (await loadLiveData())!;
  for (const [token, series] of Object.entries(delta.features)) {
    const all = fresh.features[token];
    assert.deepEqual(all.ts.slice(-series.ts.length), series.ts, `${token} tail`);
    const before = full.features[token]?.ts ?? [];
    assert.deepEqual(all.ts.slice(0, before.length), before, `${token} merged history is stable`);
  }
  console.log("ok deltas: full + delta matches a fresh load, 304 when unchanged");
}

/** The client after one full load and several deltas matches a fresh load; portfolio matches a replay. */
async function checkClient() {
  const { loadLiveData } = await import("../lib/data");
  const { LiveStore } = await import("../app/(app)/_live/live-store");
  const { portfolioAt, equityCurve } = await import("../app/(app)/_live/model");

  fixture(30000);
  const store = new LiveStore();
  let snap = store.apply((await loadLiveData())!, "")!;
  equityCurve(snap);
  for (const extra of [300, 900, 1500]) {
    fixture(30000, extra);
    const query = store.query();
    const params = new URLSearchParams(query);
    const payload = await loadLiveData({
      version: params.get("v"),
      since: Number(params.get("since")),
      fillsSince: Number(params.get("fsince")),
    });
    snap = store.apply(payload!, query)!;
    equityCurve(snap);
  }
  const fresh = new LiveStore().apply((await loadLiveData())!, "")!;
  // A fresh load merges rows older than 2 h that this client received at full resolution.
  const recentFrom = snap.range!.max - 7000;
  for (const [token, series] of fresh.features) {
    const mine = snap.features.get(token)!;
    const n = series.ts.filter((x) => x >= recentFrom).length;
    assert.deepEqual(mine.ts.slice(-n), series.ts.slice(-n), token);
    assert.deepEqual(mine.mid.slice(-n), series.mid.slice(-n), token);
  }
  for (const i of [0, 1]) {
    const ts = snap.sides[i].points.ts;
    assert.equal(ts.at(-1), fresh.sides[i].points.ts.at(-1));
    for (let k = 1; k < ts.length; k++) assert.ok(ts[k] >= ts[k - 1], "side is time-ordered");
    assert.equal(snap.sides[i].fills.length, fresh.sides[i].fills.length);
  }
  assert.deepEqual(snap.breaks, fresh.breaks);
  assert.equal(snap.fills.length, fresh.fills.length);

  const replay = (t: number) => {
    let cash = snap.config.startingCash;
    const positions: Record<string, number> = {};
    for (const f of snap.fills) {
      if (f.ts > t) break;
      const signed = f.side === "BUY" ? f.size : -f.size;
      cash -= signed * f.price + f.fee;
      positions[f.token_id] = (positions[f.token_id] ?? 0) + signed;
    }
    let equity = cash;
    for (const [token, position] of Object.entries(positions)) {
      const series = snap.features.get(token);
      if (!series || !position) continue;
      let i = -1;
      while (i + 1 < series.ts.length && series.ts[i + 1] <= t) i++;
      if (i >= 0) equity += position * series.mid[i];
    }
    return { cash, equity };
  };
  const { min, max } = snap.range!;
  for (let k = 0; k <= 20; k++) {
    const t = min + ((max - min) * k) / 20;
    const got = portfolioAt(snap, t);
    const ref = replay(t);
    close(got.cash, ref.cash);
    close(got.equity, ref.equity);
  }
  const resumed = equityCurve(snap);
  const recomputed = equityCurve({ ...snap, features: new Map(snap.features) });
  assert.deepEqual(resumed, recomputed, "resumed equity curve matches a full recompute");
  close(resumed.equity.at(-1)!, replay(max).equity);
  console.log("ok client: deltas match a fresh load, prefix portfolio and equity curve match a full replay");
}

/** The pre-cache candle builder. */
function toCandles(points: { ts: number; value: number; volume: number }[], interval: number, breaks: number[]) {
  const out: { ts: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  let nextBreak = 0;
  let broken = false;
  for (const p of points) {
    if (!Number.isFinite(p.value)) continue;
    while (nextBreak < breaks.length && breaks[nextBreak] <= p.ts) {
      nextBreak++;
      broken = true;
    }
    const ts = Math.floor(p.ts / interval) * interval;
    const last = out.at(-1);
    if (last && last.ts === ts) {
      last.high = Math.max(last.high, p.value);
      last.low = Math.min(last.low, p.value);
      last.close = p.value;
      last.volume += p.volume;
    } else if (!last || ts > last.ts) {
      const open = last && !broken ? last.close : p.value;
      broken = false;
      out.push({ ts, open, high: Math.max(open, p.value), low: Math.min(open, p.value), close: p.value, volume: p.volume });
    }
  }
  return out;
}

/** Incremental candles cut at any `t` equal candles rebuilt from the points up to `t`. */
async function checkCandles() {
  const { CandleSeries } = await import("../components/charts/candles");
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let trial = 0; trial < 200; trial++) {
    const ts: number[] = [];
    const values: number[] = [];
    const volume: number[] = [];
    const breaks = [1000 + rand() * 300, 1500 + rand() * 300].sort((a, b) => a - b);
    const interval = [1, 5, 15, 60][trial % 4];
    const series = new CandleSeries(ts, values, volume, interval, breaks);
    let t = 1000;
    for (let step = 0; step < 6; step++) {
      for (let i = Math.floor(rand() * 80); i > 0; i--) {
        t += rand() * 4;
        ts.push(t);
        values.push(rand() < 0.05 ? NaN : rand());
        volume.push(rand() < 0.5 ? 0 : rand() * 3);
      }
      series.sync();
      for (const cut of [t, t - rand() * 50, t - rand() * 200, 999]) {
        const points = ts.map((x, i) => ({ ts: x, value: values[i], volume: volume[i] })).filter((p) => p.ts <= cut);
        const ref = toCandles(points, interval, breaks);
        const got = series.upTo(cut);
        assert.equal(got.length, ref.length);
        got.forEach((c, i) => {
          for (const k of ["ts", "open", "high", "low", "close"] as const) assert.equal(c[k], ref[i][k]);
          close(c.volume, ref[i].volume);
        });
      }
    }
  }
  console.log("ok candles: incremental and cut at t match a full rebuild");
}

async function main() {
  try {
    fixture(60000);
    await check("full load");
    fixture(60000, 2500);
    await check("after append");
    fixture(8000);
    await check("after replacing the database");
    await checkDeltas();
    await checkClient();
    await checkCandles();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
