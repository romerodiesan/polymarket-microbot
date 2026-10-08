import { connection } from "next/server";
import { listRuns, startRun } from "@/lib/training";
import { hasSession, unauthorizedResponse } from "@/lib/session";

export async function GET() {
  if (!(await hasSession())) return unauthorizedResponse();
  await connection();
  return Response.json(listRuns());
}

export async function POST(request: Request) {
  if (!(await hasSession())) return unauthorizedResponse();
  const body = await request.json().catch(() => ({}));
  const horizonSeconds = Number(body.horizonSeconds ?? 15);
  const minMove = Number(body.minMove ?? 0.002);
  if (!Number.isFinite(horizonSeconds) || horizonSeconds < 1 || horizonSeconds > 3600) {
    return Response.json({ error: "horizonSeconds debe estar entre 1 y 3600 segundos" }, { status: 400 });
  }
  if (!Number.isFinite(minMove) || minMove < 0 || minMove > 1) {
    return Response.json({ error: "minMove debe estar entre 0 y 1" }, { status: 400 });
  }
  try {
    return Response.json(startRun({ horizonSeconds, minMove }), { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }
}
