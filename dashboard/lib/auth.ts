import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { ENV_FILE, readEnvFile } from "./env";

export const SESSION_COOKIE = "microbot_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const RECOMMENDED_PASSWORD_LENGTH = 12;

/** Why logging in is impossible or weak, for the server log only: never show it to visitors. */
export function passwordProblem(): { level: "error" | "warn"; message: string } | null {
  const password = dashboardPassword();
  if (!password) {
    const where = existsSync(ENV_FILE) ? `${ENV_FILE} no la define` : `no existe ${ENV_FILE}`;
    return {
      level: "error",
      message: `DASHBOARD_PASSWORD no está definida (${where} ni el entorno del proceso); nadie puede iniciar sesión. Define DASHBOARD_PASSWORD en ese .env o en el entorno, o apunta MICROBOT_ROOT a la carpeta del bot.`,
    };
  }
  if (password.length < RECOMMENDED_PASSWORD_LENGTH) {
    return {
      level: "warn",
      message: `DASHBOARD_PASSWORD tiene menos de ${RECOMMENDED_PASSWORD_LENGTH} caracteres; usa una más larga si el dashboard es accesible desde internet.`,
    };
  }
  return null;
}

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
