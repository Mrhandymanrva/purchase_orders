import { authorize } from "@/lib/auth";
import { readState } from "@/lib/store";
import { reconcile } from "@/lib/engine";
import {
  periodRange,
  periodSchema,
  scorecard,
  scorecardCSV,
} from "@/lib/scorecard";
import { scorecardPDFModel } from "@/lib/pdf-report-model";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(req: Request) {
  try {
    authorize(req);
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }
  try {
    const p = new URL(req.url).searchParams;
    const period = periodSchema.parse({
      unit: p.get("unit"),
      year: Number(p.get("year")),
      period: Number(p.get("period")),
    });
    const range = periodRange(period);
    const format = p.get("format") || "csv",
      person = p.get("person") || "all";
    if (!["csv", "pdf"].includes(format) || person.length > 500) throw Error();
    const state = await readState();
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
    if (format === "pdf") {
      const { reportPDF } = await import("@/lib/pdf-report");
      const bytes = await reportPDF(
        scorecardPDFModel(state, results, period, person),
        state,
      );
      return new Response(new Uint8Array(bytes).buffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition":
            'attachment; filename="richmond-technician-scorecard.pdf"',
          "Cache-Control": "no-store",
        },
      });
    }
    return new Response(
      scorecardCSV(scorecard(state, results, range), range, person),
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
