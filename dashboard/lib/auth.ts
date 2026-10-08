import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readEnvFile } from "./env";

export const SESSION_COOKIE = "microbot_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

/** DASHBOARD_PASSWORD from the process env or the bot's .env. Empty means nobody can log in. */
export function dashboardPassword(): string {
  return process.env.DASHBOARD_PASSWORD || readEnvFile().DASHBOARD_PASSWORD || "";
}

/** Derived from the password, so changing it invalidates every existing session. */
export function sessionToken(password: string): string {
  return createHmac("sha256", password).update("microbot-dashboard-session").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  // Hash first so lengths match and the comparison time doesn't leak the length.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function checkPassword(candidate: string): boolean {
  const password = dashboardPassword();
  return password !== "" && safeEqual(candidate, password);
}

export function isValidSession(token: string | undefined): boolean {
  const password = dashboardPassword();
  return !!token && password !== "" && safeEqual(token, sessionToken(password));
}
