import { authorize } from "@/lib/auth";
import { readState } from "@/lib/store";
import { reconcile } from "@/lib/engine";
import { reportCSV, reportSortSchema, type ReportFilter } from "@/lib/report";
import { calendarDate } from "@/lib/domain";
import { reconciliationPDFModel } from "@/lib/pdf-report-model";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(req: Request) {
  try {
    authorize(req);
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }
  const p = new URL(req.url).searchParams;
  const format = p.get("format") || "csv";
  const filter: ReportFilter = {
    individual: p.get("individual") || undefined,
    status: p.get("status") || undefined,
    query: p.get("query") || undefined,
    from: p.get("from") || undefined,
    to: p.get("to") || undefined,
  };
  try {
    if (
      !["csv", "pdf"].includes(format) ||
      Object.values(filter).some((v) => v && v.length > 500)
    )
      throw Error();
    Object.assign(
      filter,
      reportSortSchema.parse({
        sortBy: p.get("sortBy") || undefined,
        sortDirection: p.get("sortDirection") || undefined,
      }),
    );
    if (filter.from) calendarDate.parse(filter.from);
    if (filter.to) calendarDate.parse(filter.to);
    if (filter.from && filter.to && filter.from > filter.to) throw Error();
  } catch {
    return Response.json(
      { error: "Check the report format and filters." },
      { status: 400 },
    );
  }
  try {
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
        reconciliationPDFModel(state, results, filter),
        state,
      );
      return new Response(new Uint8Array(bytes).buffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition":
            'attachment; filename="richmond-reconciliation.pdf"',
          "Cache-Control": "no-store",
        },
      });
    }
    return new Response(reportCSV(state, results, filter), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition":
          'attachment; filename="richmond-card-user-report.csv"',
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json({ error: "Report unavailable" }, { status: 503 });
  }
}
