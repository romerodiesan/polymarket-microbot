import { connection } from "next/server";
import { loadCollection } from "@/lib/collection";

export async function GET() {
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
