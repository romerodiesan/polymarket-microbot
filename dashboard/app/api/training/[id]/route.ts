import { connection } from "next/server";
import { getRun } from "@/lib/training";
import { hasSession, unauthorizedResponse } from "@/lib/session";

export async function GET(_request: Request, ctx: RouteContext<"/api/training/[id]">) {
  if (!(await hasSession())) return unauthorizedResponse();
  await connection();
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return Response.json({ error: "Entrenamiento no encontrado" }, { status: 404 });
  return Response.json(run);
}
