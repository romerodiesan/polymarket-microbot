import { stopRun } from "@/lib/training";

export async function POST(_request: Request, ctx: RouteContext<"/api/training/[id]/stop">) {
  const { id } = await ctx.params;
  try {
    return Response.json(stopRun(id));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }
}
