import { connection } from "next/server";
import { loadBooks } from "@/lib/book";
import { hasSession, unauthorizedResponse } from "@/lib/session";

/** GET ?tokens=a,b[&t=unix seconds]: live book when t is now or omitted, replayed otherwise. */
export async function GET(request: Request) {
  if (!(await hasSession())) return unauthorizedResponse();
  await connection();
  const params = new URL(request.url).searchParams;
  const tokens = (params.get("tokens") ?? "").split(",").filter((t) => /^\d+$/.test(t)).slice(0, 4);
  const raw = params.get("t");
  const t = raw === null || raw === "" ? null : Number(raw);
  if (t !== null && !Number.isFinite(t)) return Response.json({ error: "t inválido" }, { status: 400 });
  if (t === null && !tokens.length) return Response.json(await loadBooks([], null));
  if (!tokens.length) return Response.json({ error: "Faltan tokens" }, { status: 400 });
  try {
    return Response.json(await loadBooks(tokens, t));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
