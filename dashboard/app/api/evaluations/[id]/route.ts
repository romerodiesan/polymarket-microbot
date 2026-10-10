import { connection } from "next/server";
import { getEvaluation } from "@/lib/evaluations";
import { hasSession, unauthorizedResponse } from "@/lib/session";

export async function GET(_request: Request, ctx: RouteContext<"/api/evaluations/[id]">) {
  if (!(await hasSession())) return unauthorizedResponse();
  await connection();
  const { id } = await ctx.params;
  const evaluation = getEvaluation(id);
  if (!evaluation) return Response.json({ error: "Evaluación no encontrada" }, { status: 404 });
  return Response.json(evaluation);
}
