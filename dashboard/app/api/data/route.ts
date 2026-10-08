import { connection, type NextRequest } from "next/server";
import { loadBotData, loadBotStatus } from "@/lib/data";
import { hasSession, unauthorizedResponse } from "@/lib/session";

export async function GET(request: NextRequest) {
  if (!(await hasSession())) return unauthorizedResponse();
  await connection();
  try {
    if (request.nextUrl.searchParams.get("view") === "status") return Response.json(loadBotStatus());
    return Response.json(await loadBotData());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
