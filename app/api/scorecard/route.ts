import { authorize } from "@/lib/auth";
import { readState } from "@/lib/store";
import { reconcile } from "@/lib/engine";
import { periodRange, scorecard, scorecardCSV } from "@/lib/scorecard";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    authorize(req);
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }
  try {
    const p = new URL(req.url).searchParams;
    const range = periodRange({
      unit: p.get("unit") as "month",
      year: Number(p.get("year")),
      period: Number(p.get("period")),
    });
    const state = await readState();
    const results = reconcile(
      state.records,
      state.config,
      state.rules,
      state.mode === "demo"
        ? "2026-09-13"
        : new Date().toISOString().slice(0, 10),
      state.decisions,
    );
    return new Response(
      scorecardCSV(
        scorecard(state, results, range),
        range,
        p.get("person") || "all",
      ),
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition":
            'attachment; filename="richmond-technician-scorecard.csv"',
          "Cache-Control": "no-store",
        },
      },
    );
  } catch {
    return Response.json(
      {
        error:
          "Unable to export scorecard. Check the selected reporting period.",
      },
      { status: 400 },
    );
  }
}
