import { connection } from "next/server";
import { loadBotData } from "@/lib/data";

export async function GET() {
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
