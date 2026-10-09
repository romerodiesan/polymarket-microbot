"use server";

import { setTimeout as sleep } from "node:timers/promises";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, SESSION_MAX_AGE, checkPassword, dashboardPassword, passwordProblem, sessionToken } from "@/lib/auth";

export type LoginState = { error: string | null };

/** Only same-origin paths, so `?next=` can't be used as an open redirect. */
function safeNext(value: FormDataEntryValue | null): string {
  const next = typeof value === "string" ? value : "";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

export async function login(_: LoginState, formData: FormData): Promise<LoginState> {
  if (!dashboardPassword()) {
    console.error(`[auth] ${passwordProblem()?.message}`);
    return { error: "El acceso no está disponible. Revisa la configuración del servidor." };
  }
  const password = formData.get("password");
  if (typeof password !== "string" || !checkPassword(password)) {
    // Slows down brute-force guessing.
    await sleep(800);
    return { error: "Contraseña incorrecta." };
  }
  (await cookies()).set(SESSION_COOKIE, sessionToken(dashboardPassword()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  redirect(safeNext(formData.get("next")));
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
