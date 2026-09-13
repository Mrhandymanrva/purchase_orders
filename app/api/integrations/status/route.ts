import { authorize } from "@/lib/auth";
import { demoMode } from "@/lib/store";
import { readIntegrationSetup } from "@/lib/integrations";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    authorize(req);
  } catch {
    return Response.json({ error: "Unauthorized request" }, { status: 401 });
  }
  try {
    return Response.json(
      demoMode()
        ? { demo: true }
        : { demo: false, setup: await readIntegrationSetup() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        error:
          "Could not check connection settings. Check database availability and retry.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
