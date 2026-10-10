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
  const holdoutMarkets = Number(body.holdoutMarkets ?? 0.2);
  const folds = Number(body.folds ?? 4);
  const embargoMarkets = Number(body.embargoMarkets ?? 1);
  if (!Number.isFinite(holdoutMarkets) || holdoutMarkets <= 0 || holdoutMarkets >= 0.9) {
    return Response.json({ error: "holdoutMarkets debe estar entre 0 y 0.9" }, { status: 400 });
  }
  if (!Number.isInteger(folds) || folds < 1 || folds > 20) {
    return Response.json({ error: "folds debe ser un entero entre 1 y 20" }, { status: 400 });
  }
  if (!Number.isInteger(embargoMarkets) || embargoMarkets < 0 || embargoMarkets > 10) {
    return Response.json({ error: "embargoMarkets debe ser un entero entre 0 y 10" }, { status: 400 });
  }
  try {
    return Response.json(
      startRun({ horizonSeconds, minMove, holdoutMarkets, folds, embargoMarkets }),
      { status: 201 },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }
}
