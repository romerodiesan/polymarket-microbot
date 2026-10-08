import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.MICROBOT_ROOT ?? "..");

/** The bot's .env at the repo root; read on every call so edits apply without a restart. */
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

/** An executable from the project's virtualenv (.bot or .venv), or null when there is none. */
export function venvBin(name: string): string | null {
  for (const venv of [".bot", ".venv"]) {
    const candidate = path.join(/*turbopackIgnore: true*/ ROOT, venv, "bin", name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function pythonBin(): string {
  return process.env.MICROBOT_PYTHON || venvBin("python") || "python3";
}
