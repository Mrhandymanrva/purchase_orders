import { readState } from "@/lib/store";
import { authorize } from "@/lib/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    authorize(req);
    return Response.json(await readState(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error(
      "State unavailable",
      e instanceof Error ? e.message : "error",
    );
    return Response.json(
      {
        error:
          "Workspace unavailable. Check authentication and database configuration.",
      },
      { status: 503 },
    );
  }
}
