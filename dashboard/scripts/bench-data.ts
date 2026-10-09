/**
 * Timings of the data path on a production-sized synthetic export.
 *
 *   npm run bench:data [-- <feature rows> <fills>]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROWS = Number(process.argv[3] ?? 250_000);
const FILLS = Number(process.argv[4] ?? 8_500);
const APPEND = 1_000;

const root = mkdtempSync(path.join(tmpdir(), "microbot-bench-"));
process.env.MICROBOT_ROOT = root;
const python = path.resolve(__dirname, "../../bot/.bot/bin/python");
const fixture = (append = 0) =>
  execFileSync(python, [path.join(__dirname, "make-fixture.py"), root, String(ROWS), String(FILLS), ...(append ? ["--append", String(append)] : [])]);

async function time<T>(label: string, fn: () => Promise<T> | T, runs = 1): Promise<T> {
  let result!: T;
  const start = performance.now();
  for (let i = 0; i < runs; i++) result = await fn();
  const ms = (performance.now() - start) / runs;
  console.log(`${label.padEnd(44)} ${ms < 10 ? ms.toFixed(2) : ms.toFixed(0)} ms`);
  return result;
}

const mb = (value: unknown) => `${(JSON.stringify(value).length / 1e6).toFixed(2)} MB`;

async function main() {
  const { loadLiveData } = await import("../lib/data");
  const { loadCollection } = await import("../lib/collection");
  const { LiveStore } = await import("../app/(app)/_live/live-store");
  const { equityCurve, portfolioAt } = await import("../app/(app)/_live/model");
  const { candleSeries } = await import("../components/charts/candles");

  console.log(`${ROWS} feature rows, ${FILLS} fills, then +${APPEND} rows\n`);
  fixture();
  const { featureStore, fillsStore } = await import("../lib/store");
  const { parquetPaths, readEnvFile } = await import("../lib/data");
  const files = parquetPaths(readEnvFile());
  await time("decode the whole export (first sync)", () =>
    Promise.all([featureStore(files.featuresFile), fillsStore(files.fillsFile)]));
  await loadLiveData(); // one Gamma lookup, cached from here on
  const full = (await time("/api/data full load", () => loadLiveData(), 5))!;
  console.log(`${"  full payload".padEnd(44)} ${mb(full)}`);
  await time("/api/data with nothing new (304)", () =>
    loadLiveData({ version: full.version, since: full.cursor, fillsSince: full.fillsCursor }), 20);
  await time("/data first aggregation", () => loadCollection());
  await time("/data poll", () => loadCollection(), 20);

  fixture(APPEND);
  const delta = (await time(`export +${APPEND} rows → /api/data delta`, () =>
    loadLiveData({ version: full.version, since: full.cursor, fillsSince: full.fillsCursor })))!;
  console.log(`${"  delta payload".padEnd(44)} ${mb(delta)}`);
  await time(`/data poll after +${APPEND} rows`, () => loadCollection());

  console.log("\nclient");
  const store = new LiveStore();
  const snap = (await time("apply full payload", () => store.apply(JSON.parse(JSON.stringify(full)), "")))!;
  const query = store.query();
  await time("equity curve, full", () => equityCurve({ ...snap, features: new Map(snap.features) }), 5);
  equityCurve(snap);
  const next = (await time("apply delta", () => store.apply(JSON.parse(JSON.stringify(delta)), query)))!;
  const curve = await time("equity curve, resumed after the delta", () => equityCurve(next));
  const { min, max } = next.range!;
  const side = next.sides[0].points;
  const ticks = Array.from({ length: 1000 }, (_, i) => min + ((max - min) * i) / 1000);
  await time("replay tick: portfolio + 4 charts (per t)", () => {
    for (const t of ticks) {
      portfolioAt(next, t);
      candleSeries(side.ts, side.mid, 60, next.breaks, side.volume).upTo(t);
      candleSeries(side.ts, side.bid, 60, next.breaks).upTo(t);
      candleSeries(side.ts, side.score, 60, next.breaks).upTo(t);
      candleSeries(curve.ts, curve.equity, 60, []).upTo(t);
    }
  }).then(() => undefined);
  console.log(`${"  (divide the line above by 1000)".padEnd(44)}`);
  void snap;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(root, { recursive: true, force: true }));
