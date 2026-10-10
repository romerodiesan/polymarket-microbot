import "server-only";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./data";
import { pythonBin } from "./env";
import { listRuns } from "./training";

const EVAL_DIR = path.join(/*turbopackIgnore: true*/ ROOT, "data", "evaluations");
const LOG_TAIL_BYTES = 64 * 1024;

export type EvaluationStatus = "running" | "succeeded" | "failed" | "stopped" | "interrupted";

export type EvaluationParams = {
  /** Path of a model.joblib relative to the bot directory; null scores with the recorded signal. */
  model: string | null;
  latencyMs: number | null;
  fetchResolutions: boolean;
  walkForward: boolean;
  noL2: boolean;
};

export type Interval = { low: number; high: number };

export type ScenarioReport = {
  latency_multiplier: number;
  extra_slippage_ticks: number;
  fee_multiplier: number;
  fill_haircut: number;
  markets: {
    total: number;
    included: number;
    settled_by_payout: number;
    flat_without_resolution: number;
    excluded_unresolved: number;
    traded: number;
    fidelity: Record<string, number>;
  };
  net_pnl: number;
  fees: number;
  entries: number;
  expectancy_per_trade: number | null;
  expectancy_per_market: number | null;
  expectancy_per_traded_market: number | null;
  max_capital_committed: number;
  roi_on_max_committed: number | null;
  sharpe_per_market: number | null;
  sortino_per_market: number | null;
  profit_factor: number | null;
  win_rate_markets: number | null;
  win_rate_trades: number | null;
  drawdown: { max: number; duration_seconds: number; duration_markets: number };
  weekly: Record<string, { markets: number; pnl: number; fees: number; entries: number }>;
  concentration: { top5_pnl: number; top5_share_of_net: number | null };
  execution: {
    orders: number;
    fill_rate: number | null;
    partial_rate: number | null;
    reject_rate: number | null;
    mean_entry_slippage_vs_touch: number | null;
  };
  bootstrap: { total_pnl: Interval; mean_market_pnl: Interval; samples: number } | null;
  per_market: {
    market: string;
    end_ts?: number;
    pnl: number;
    fees: number;
    entries: number;
    settled_by: string;
    fidelity: string;
  }[];
};

export type EvaluationReport = {
  id: string;
  created_at: string;
  model: string | null;
  fee_rate: number;
  rollover_seconds: number;
  signal: string;
  latency_ms: number;
  scenarios: Record<string, ScenarioReport>;
  baselines: Record<string, { net_pnl: number; entries: number; expectancy_per_trade: number | null; win_rate_trades: number | null; fees: number }>;
  paper_vs_replay?: Record<string, number>;
  walk_forward?: {
    split: { dev_markets: number; test_markets: number };
    folds: {
      fold: number;
      train_markets: number;
      valid_markets: number;
      error?: string;
      scenarios?: Record<string, { net_pnl: number; entries: number; expectancy_per_trade: number | null; roi_on_max_committed: number | null }>;
    }[];
    pessimistic_positive_folds: number;
    pessimistic_net_pnl: number;
  };
};

export type EvaluationSummary = {
  markets: number;
  excluded: number;
  netPnl: Record<string, number>;
};

export type Evaluation = {
  id: string;
  status: EvaluationStatus;
  /** Null for reports produced from the command line. */
  params: EvaluationParams | null;
  pid: number | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  stopRequested: boolean;
  signal: string | null;
  summary: EvaluationSummary | null;
};

export type ModelOption = { path: string; label: string; active: boolean };

type Meta = Omit<Evaluation, "signal" | "summary">;

const dir = (id: string) => path.join(EVAL_DIR, id);
const metaFile = (id: string) => path.join(dir(id), "meta.json");
const reportFile = (id: string) => path.join(dir(id), "report.json");
const logFile = (id: string) => path.join(dir(id), "evaluate.log");

const isValidId = (id: string) => /^[\w-]+$/.test(id) && (existsSync(metaFile(id)) || existsSync(reportFile(id)));

function writeMeta(meta: Meta) {
  writeFileSync(metaFile(meta.id), JSON.stringify(meta, null, 2));
}

function readReport(id: string): EvaluationReport | null {
  try {
    return JSON.parse(readFileSync(reportFile(id), "utf8"));
  } catch {
    return null;
  }
}

function isAlive(pid: number | null) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readMeta(id: string): Meta {
  if (existsSync(metaFile(id))) return JSON.parse(readFileSync(metaFile(id), "utf8"));
  const report = readReport(id);
  const created = report?.created_at ? Date.parse(report.created_at) / 1000 : statSync(reportFile(id)).mtimeMs / 1000;
  return {
    id,
    status: "succeeded",
    params: null,
    pid: null,
    startedAt: created,
    endedAt: created,
    exitCode: 0,
    stopRequested: false,
  };
}

function finalize(id: string, exitCode: number | null) {
  const meta = readMeta(id);
  if (meta.status !== "running") return;
  meta.exitCode = exitCode;
  meta.endedAt = Date.now() / 1000;
  meta.pid = null;
  meta.status = meta.stopRequested ? "stopped" : exitCode === 0 && existsSync(reportFile(id)) ? "succeeded" : "failed";
  writeMeta(meta);
}

function summarize(report: EvaluationReport | null): EvaluationSummary | null {
  if (!report?.scenarios) return null;
  const base = report.scenarios.base ?? Object.values(report.scenarios)[0];
  return {
    markets: base?.markets.included ?? 0,
    excluded: base?.markets.excluded_unresolved ?? 0,
    netPnl: Object.fromEntries(Object.entries(report.scenarios).map(([name, s]) => [name, s.net_pnl])),
  };
}

function hydrate(meta: Meta): Evaluation {
  if (meta.status === "running" && !isAlive(meta.pid)) {
    meta.status = meta.stopRequested ? "stopped" : existsSync(reportFile(meta.id)) ? "succeeded" : "interrupted";
    meta.endedAt ??= Date.now() / 1000;
    meta.pid = null;
    writeMeta(meta);
  }
  const report = readReport(meta.id);
  return { ...meta, signal: report?.signal ?? null, summary: summarize(report) };
}

export function listEvaluations(): Evaluation[] {
  if (!existsSync(EVAL_DIR)) return [];
  return readdirSync(EVAL_DIR)
    .filter(isValidId)
    .map((id) => hydrate(readMeta(id)))
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function getEvaluation(id: string): (Evaluation & { log: string; report: EvaluationReport | null }) | null {
  if (!isValidId(id)) return null;
  const evaluation = hydrate(readMeta(id));
  let log = "";
  if (existsSync(logFile(id))) {
    const { size } = statSync(logFile(id));
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(logFile(id), "r");
    readSync(fd, buffer, 0, buffer.length, start);
    closeSync(fd);
    log = buffer.toString("utf8");
  }
  return { ...evaluation, log, report: readReport(id) };
}

/** Models a replay can score with: every finished training run, active one first. */
export function modelOptions(): ModelOption[] {
  return listRuns()
    .filter((r) => r.status === "succeeded" && existsSync(path.resolve(ROOT, r.modelPath)))
    .map((r) => ({
      path: r.modelPath,
      label: `${r.id.replace(/^run-/, "")}${r.metrics?.roc_auc != null ? ` · AUC ${r.metrics.roc_auc.toFixed(3)}` : ""}`,
      active: r.active,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active));
}

export function startEvaluation(params: EvaluationParams): Evaluation {
  if (listEvaluations().some((e) => e.status === "running")) {
    throw new Error("Ya hay una evaluación en curso");
  }
  if (params.model && !modelOptions().some((m) => m.path === params.model)) {
    throw new Error("Modelo no encontrado");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const id = `eval-${stamp}`;
  mkdirSync(dir(id), { recursive: true });
  const args = ["-m", "microbot.evaluate", "--data-dir", "data", "--output", dir(id)];
  if (params.model) args.push("--model", params.model);
  if (params.latencyMs !== null) args.push("--latency-ms", String(params.latencyMs));
  if (params.fetchResolutions) args.push("--fetch-resolutions");
  if (params.walkForward) args.push("--walk-forward");
  if (params.noL2) args.push("--no-l2");

  writeFileSync(logFile(id), `$ ${pythonBin()} ${args.join(" ")}\n`);
  const out = openSync(logFile(id), "a");
  const child = spawn(pythonBin(), args, {
    cwd: ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHON_COLORS: "0", NO_COLOR: "1" },
    stdio: ["ignore", out, out],
  });
  closeSync(out);

  const meta: Meta = {
    id,
    status: "running",
    params,
    pid: child.pid ?? null,
    startedAt: Date.now() / 1000,
    endedAt: null,
    exitCode: null,
    stopRequested: false,
  };
  writeMeta(meta);
  child.on("exit", (code) => finalize(id, code));
  child.on("error", (error) => {
    writeFileSync(logFile(id), `\n${error.message}\n`, { flag: "a" });
    finalize(id, -1);
  });
  return hydrate(meta);
}

export function stopEvaluation(id: string): Evaluation {
  if (!isValidId(id) || !existsSync(metaFile(id))) throw new Error("Evaluación no encontrada");
  const meta = readMeta(id);
  if (meta.status !== "running" || !meta.pid) throw new Error("La evaluación no está en curso");
  meta.stopRequested = true;
  writeMeta(meta);
  const pid = meta.pid;
  process.kill(pid, "SIGTERM");
  setTimeout(() => {
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }, 5000);
  return hydrate(meta);
}
