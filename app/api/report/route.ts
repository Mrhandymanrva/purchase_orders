import { authorize } from "@/lib/auth";
import { readState } from "@/lib/store";
import { reconcile } from "@/lib/engine";
import { reportCSV } from "@/lib/report";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    authorize(req);
    const state = await readState(),
      p = new URL(req.url).searchParams;
    const results = reconcile(
      state.records,
      state.config,
      state.rules,
      state.mode === "demo"
        ? "2026-09-13"
        : new Date().toISOString().slice(0, 10),
      state.decisions,
      state.coverage,
    );
    return new Response(
      reportCSV(state, results, {
        individual: p.get("individual") || undefined,
        status: p.get("status") || undefined,
        query: p.get("query") || undefined,
        from: p.get("from") || undefined,
        to: p.get("to") || undefined,
      }),
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition":
            'attachment; filename="richmond-card-user-report.csv"',
          "Cache-Control": "no-store",
        },
      },
    );
  } catch {
    return Response.json({ error: "Report unavailable" }, { status: 503 });
  }
}
