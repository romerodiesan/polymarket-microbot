import "server-only";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ROOT, readEnvFile } from "./data";
import { pythonBin } from "./env";

const RUNS_DIR = path.join(/*turbopackIgnore: true*/ ROOT, "data", "training");
const LOG_TAIL_BYTES = 64 * 1024;

export type RunStatus = "running" | "succeeded" | "failed" | "stopped" | "interrupted";

/** `horizonSamples` only exists on runs created before the horizon moved to seconds. */
export type RunParams = { horizonSeconds?: number; horizonSamples?: number; minMove: number };

export type RunMetrics = {
  roc_auc: number;
  rows_total: number;
  rows_labelled: number;
  train_rows: number;
  test_rows: number;
  positive_rate: number;
  rows_usable?: number;
  class_counts?: { train: Record<string, number>; test: Record<string, number> };
  high_confidence?: { threshold: number; coverage: number; accuracy: number | null };
  horizon_seconds?: number;
  embargo_seconds?: number;
  model_path: string;
  report: Record<string, Record<string, number> | number>;
  coefficients: Record<string, number>;
};

export type Run = {
  id: string;
  status: RunStatus;
  params: RunParams;
  pid: number | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  stopRequested: boolean;
  modelPath: string;
  active: boolean;
  metrics: RunMetrics | null;
};

type Meta = Omit<Run, "active" | "metrics">;

const runDir = (id: string) => path.join(RUNS_DIR, id);
const metaFile = (id: string) => path.join(runDir(id), "meta.json");
const logFile = (id: string) => path.join(runDir(id), "train.log");
const metricsFile = (id: string) => path.join(runDir(id), "metrics.json");

function isValidId(id: string) {
  return /^[\w-]+$/.test(id) && existsSync(metaFile(id));
}

function readMeta(id: string): Meta {
  return JSON.parse(readFileSync(metaFile(id), "utf8"));
}

function writeMeta(meta: Meta) {
  writeFileSync(metaFile(meta.id), JSON.stringify(meta, null, 2));
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

function finalize(id: string, exitCode: number | null) {
  const meta = readMeta(id);
  if (meta.status !== "running") return;
  meta.exitCode = exitCode;
  meta.endedAt = Date.now() / 1000;
  meta.pid = null;
  meta.status = meta.stopRequested
    ? "stopped"
    : exitCode === 0 || existsSync(metricsFile(id))
      ? "succeeded"
      : "failed";
  writeMeta(meta);
}

function hydrate(meta: Meta, activeModel: string | null): Run {
  // A run whose process died while the dashboard wasn't watching (e.g. server restart).
  if (meta.status === "running" && !isAlive(meta.pid)) {
    meta.status = meta.stopRequested
      ? "stopped"
      : existsSync(metricsFile(meta.id))
        ? "succeeded"
        : "interrupted";
    meta.endedAt ??= Date.now() / 1000;
    meta.pid = null;
    writeMeta(meta);
  }
  const metrics = existsSync(metricsFile(meta.id))
    ? (JSON.parse(readFileSync(metricsFile(meta.id), "utf8")) as RunMetrics)
    : null;
  return { ...meta, metrics, active: activeModel === path.resolve(ROOT, meta.modelPath) };
}

function activeModelPath() {
  const value = readEnvFile().PM_MODEL_PATH;
  return value ? path.resolve(ROOT, value) : null;
}

export function listRuns(): Run[] {
  if (!existsSync(RUNS_DIR)) return [];
  const active = activeModelPath();
  return readdirSync(RUNS_DIR)
    .filter(isValidId)
    .map((id) => hydrate(readMeta(id), active))
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function getRun(id: string): (Run & { log: string }) | null {
  if (!isValidId(id)) return null;
  const run = hydrate(readMeta(id), activeModelPath());
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
  return { ...run, log };
}

export function startRun(params: RunParams): Run {
  if (listRuns().some((r) => r.status === "running")) {
    throw new Error("Ya hay un entrenamiento en curso");
  }
  const env = readEnvFile();
  const features = path.resolve(ROOT, env.PM_PARQUET_DIR || "data/parquet", "features.parquet");
  if (!existsSync(features)) {
    throw new Error("No existe features.parquet; ejecuta microbot para recopilar datos");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const id = `run-${stamp}`;
  mkdirSync(runDir(id), { recursive: true });
  const modelPath = path.relative(ROOT, path.join(runDir(id), "model.joblib"));
  const args = [
    "-m", "microbot.train",
    "--features", features,
    "--output", modelPath,
    "--metrics", metricsFile(id),
    "--horizon-seconds", String(params.horizonSeconds),
    "--min-move", String(params.minMove),
  ];

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
    modelPath,
  };
  writeMeta(meta);
  child.on("exit", (code) => finalize(id, code));
  child.on("error", (error) => {
    writeFileSync(logFile(id), `\n${error.message}\n`, { flag: "a" });
    finalize(id, -1);
  });
  return hydrate(meta, activeModelPath());
}

export function stopRun(id: string): Run {
  if (!isValidId(id)) throw new Error("Entrenamiento no encontrado");
  const meta = readMeta(id);
  if (meta.status !== "running" || !meta.pid) throw new Error("El entrenamiento no está en curso");
  meta.stopRequested = true;
  writeMeta(meta);
  const pid = meta.pid;
  process.kill(pid, "SIGTERM");
  setTimeout(() => {
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }, 5000);
  return hydrate(meta, activeModelPath());
}
