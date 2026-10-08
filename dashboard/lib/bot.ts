import "server-only";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadBotStatus, type BotStatus } from "./data";
import { ROOT, pythonBin, readEnvFile, venvBin } from "./env";

const BOT_DIR = path.join(/*turbopackIgnore: true*/ ROOT, "data", "bot");
const STATE_FILE = path.join(BOT_DIR, "state.json");
const LOG_FILE = path.join(BOT_DIR, "bot.log");
const LOG_TAIL_BYTES = 16 * 1024;
/** A bot that dies this soon after spawning failed to start (bad .env, missing deps...). */
const STARTUP_GRACE_MS = 2000;
/** SIGTERM lets the bot flush DuckDB and export Parquet; SIGKILL only if it hangs. */
const KILL_AFTER_MS = 20_000;

/** Matches `.../bin/microbot`, `-m microbot[.main]` and `microbot/main.py`, but not microbot-train. */
const BOT_COMMAND = /(?:\/microbot|-m\s+microbot(?:\.main)?|microbot\/main\.py)(?:\s|$)/;

type State = {
  pid: number | null;
  startedAt: number | null;
  stopRequestedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
};

export type BotProcess = {
  running: boolean;
  pid: number | null;
  /** Started from this dashboard (log available) rather than from a terminal. */
  managed: boolean;
  startedAt: number | null;
  stopping: boolean;
  /** How the last dashboard-started bot ended, while it is not running. */
  lastExit: { code: number | null; endedAt: number } | null;
};

export type BotOverview = BotStatus & {
  series: string | null;
  process: BotProcess;
  log?: string;
};

const EMPTY_STATE: State = { pid: null, startedAt: null, stopRequestedAt: null, endedAt: null, exitCode: null };

function readState(): State {
  try {
    return { ...EMPTY_STATE, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
  } catch {
    return EMPTY_STATE;
  }
}

function writeState(state: State) {
  mkdirSync(BOT_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function isAlive(pid: number | null): pid is number {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `[[dd-]hh:]mm:ss` from ps into seconds. */
function parseElapsed(value: string): number {
  const [days, clock] = value.includes("-") ? value.split("-") : ["0", value];
  const parts = clock.split(":").map(Number).reverse();
  return Number(days) * 86400 + (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600;
}

/** Bot processes on this machine, including ones started from a terminal. */
function findBotProcesses(): { pid: number; startedAt: number }[] {
  let output = "";
  try {
    output = execFileSync("ps", ["-axo", "pid=,etime=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const now = Date.now() / 1000;
  const found: { pid: number; startedAt: number }[] = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!match || !BOT_COMMAND.test(match[3])) continue;
    const pid = Number(match[1]);
    if (pid !== process.pid) found.push({ pid, startedAt: now - parseElapsed(match[2]) });
  }
  return found;
}

function readLogTail(): string {
  if (!existsSync(LOG_FILE)) return "";
  const { size } = statSync(LOG_FILE);
  const start = Math.max(0, size - LOG_TAIL_BYTES);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(LOG_FILE, "r");
  readSync(fd, buffer, 0, buffer.length, start);
  closeSync(fd);
  return buffer.toString("utf8");
}

function currentProcess(): BotProcess {
  const state = readState();
  if (isAlive(state.pid)) {
    return {
      running: true,
      pid: state.pid,
      managed: true,
      startedAt: state.startedAt,
      stopping: state.stopRequestedAt !== null,
      lastExit: null,
    };
  }
  // The managed bot died while nobody was watching (e.g. dashboard restart): record it.
  if (state.pid) {
    const ended = { ...state, pid: null, endedAt: state.endedAt ?? Date.now() / 1000 };
    writeState(ended);
    Object.assign(state, ended);
  }
  const lastExit = state.endedAt ? { code: state.exitCode, endedAt: state.endedAt } : null;
  const external = findBotProcesses()[0];
  if (external) {
    const stopping = state.stopRequestedAt !== null && state.stopRequestedAt > external.startedAt;
    return { running: true, pid: external.pid, managed: false, startedAt: external.startedAt, stopping, lastExit };
  }
  return { running: false, pid: null, managed: false, startedAt: null, stopping: false, lastExit };
}

export function botOverview({ withLog = false } = {}): BotOverview {
  const env = readEnvFile();
  const series = env.PM_SERIES_SLUG || null;
  return { ...loadBotStatus(), series, process: currentProcess(), ...(withLog ? { log: readLogTail() } : {}) };
}

function botCommand(): [string, string[]] {
  const script = venvBin("microbot");
  return script ? [script, []] : [pythonBin(), ["-m", "microbot.main"]];
}

export async function startBot(): Promise<BotOverview> {
  if (currentProcess().running) throw new Error("El bot ya está en marcha");

  const [command, args] = botCommand();
  mkdirSync(BOT_DIR, { recursive: true });
  writeFileSync(LOG_FILE, `$ ${[command, ...args].join(" ")}\n`);
  const out = openSync(LOG_FILE, "a");
  // Detached in its own process group: restarting the dashboard (Ctrl+C) must not stop the bot.
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: true,
    env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHON_COLORS: "0", NO_COLOR: "1" },
    stdio: ["ignore", out, out],
  });
  closeSync(out);
  child.unref();

  const startedAt = Date.now() / 1000;
  writeState({ ...EMPTY_STATE, pid: child.pid ?? null, startedAt });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      const state = readState();
      if (state.pid === child.pid) writeState({ ...state, pid: null, endedAt: Date.now() / 1000, exitCode: code });
      resolve(code);
    });
    child.on("error", (error) => {
      writeFileSync(LOG_FILE, `\n${error.message}\n`, { flag: "a" });
      writeState({ ...readState(), pid: null, endedAt: Date.now() / 1000, exitCode: -1 });
      resolve(-1);
    });
  });

  const early = await Promise.race([exited, new Promise<"alive">((r) => setTimeout(() => r("alive"), STARTUP_GRACE_MS))]);
  if (early !== "alive") {
    const lastLine = readLogTail().trim().split("\n").at(-1) ?? "";
    throw new Error(`El bot se cerró al arrancar (código ${early ?? "?"})${lastLine ? `: ${lastLine}` : ""}`);
  }
  return botOverview({ withLog: true });
}

export function stopBot(): BotOverview {
  const proc = currentProcess();
  if (!proc.running || !proc.pid) throw new Error("El bot no está en marcha");
  const pid = proc.pid;
  writeState({ ...readState(), stopRequestedAt: Date.now() / 1000 });
  process.kill(pid, "SIGTERM");
  setTimeout(() => {
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }, KILL_AFTER_MS).unref();
  return botOverview({ withLog: true });
}
