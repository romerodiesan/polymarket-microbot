import { connection } from "next/server";
import { loadBotData } from "@/lib/data";
import { hasSession, unauthorizedResponse } from "@/lib/session";

export async function GET() {
  if (!(await hasSession())) return unauthorizedResponse();
  await connection();
  try {
    return Response.json(await loadBotData());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
