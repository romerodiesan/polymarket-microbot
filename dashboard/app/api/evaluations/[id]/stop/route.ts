import { stopEvaluation } from "@/lib/evaluations";
import { hasSession, unauthorizedResponse } from "@/lib/session";

export async function POST(_request: Request, ctx: RouteContext<"/api/evaluations/[id]/stop">) {
  if (!(await hasSession())) return unauthorizedResponse();
  const { id } = await ctx.params;
  try {
    return Response.json(stopEvaluation(id));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
