import { connection, type NextRequest } from "next/server";
import { botOverview, startBot, stopBot } from "@/lib/bot";
import { hasSession, unauthorizedResponse } from "@/lib/session";

export async function GET(request: NextRequest) {
  if (!(await hasSession())) return unauthorizedResponse();
  await connection();
  return Response.json(botOverview({ withLog: request.nextUrl.searchParams.has("log") }));
}

export async function POST(request: Request) {
  if (!(await hasSession())) return unauthorizedResponse();
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === "start") return Response.json(await startBot());
    if (body.action === "stop") return Response.json(stopBot());
    return Response.json({ error: "Acción no válida" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
