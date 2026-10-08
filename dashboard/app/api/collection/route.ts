import { connection } from "next/server";
import { loadCollection } from "@/lib/collection";
import { hasSession, unauthorizedResponse } from "@/lib/session";

export async function GET() {
  if (!(await hasSession())) return unauthorizedResponse();
  await connection();
  try {
    return Response.json(await loadCollection());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
