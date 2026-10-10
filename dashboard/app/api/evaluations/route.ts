import { connection } from "next/server";
import { listEvaluations, modelOptions, startEvaluation } from "@/lib/evaluations";
import { hasSession, unauthorizedResponse } from "@/lib/session";

export async function GET() {
  if (!(await hasSession())) return unauthorizedResponse();
  await connection();
  return Response.json({ evaluations: listEvaluations(), models: modelOptions() });
}

export async function POST(request: Request) {
  if (!(await hasSession())) return unauthorizedResponse();
  const body = await request.json().catch(() => ({}));
  const latency = body.latencyMs === null || body.latencyMs === undefined || body.latencyMs === "" ? null : Number(body.latencyMs);
  if (latency !== null && (!Number.isFinite(latency) || latency < 0 || latency > 60_000)) {
    return Response.json({ error: "latencyMs debe estar entre 0 y 60000" }, { status: 400 });
  }
  const model = typeof body.model === "string" && body.model ? body.model : null;
  try {
    const evaluation = startEvaluation({
      model,
      latencyMs: latency,
      fetchResolutions: Boolean(body.fetchResolutions),
      walkForward: Boolean(body.walkForward),
      noL2: Boolean(body.noL2),
    });
    return Response.json(evaluation, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
