import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE, isValidSession } from "./auth";

export async function hasSession(): Promise<boolean> {
  return isValidSession((await cookies()).get(SESSION_COOKIE)?.value);
}

export const unauthorizedResponse = () => Response.json({ error: "No autenticado" }, { status: 401 });
