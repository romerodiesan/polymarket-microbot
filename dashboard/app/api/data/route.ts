import { connection, type NextRequest } from "next/server";
import { loadLiveData } from "@/lib/data";
import { hasSession, unauthorizedResponse } from "@/lib/session";

const cursor = (value: string | null) => (value === null || value === "" ? undefined : Number(value));

/**
 * `?v=<version>&since=<rows>&fsince=<fills>&osince=<orders>&rkey=<markets key>` returns only what
 * was appended or changed since; 304 if nothing.
 */
export async function GET(request: NextRequest) {
  if (!(await hasSession())) return unauthorizedResponse();
  await connection();
  const params = request.nextUrl.searchParams;
  try {
    const payload = await loadLiveData({
      version: params.get("v"),
      since: cursor(params.get("since")),
      fillsSince: cursor(params.get("fsince")),
      ordersSince: cursor(params.get("osince")),
      resolutionsKey: params.get("rkey"),
    });
    if (!payload) return new Response(null, { status: 304 });
    return Response.json(payload);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
