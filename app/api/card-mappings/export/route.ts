import { authorize } from "@/lib/auth";
import { readState } from "@/lib/store";
export const dynamic = "force-dynamic";
const csv = (v: string) =>
  '"' + (/^[=+\-@]/.test(v) ? "'" + v : v).replace(/"/g, '""') + '"';
export async function GET(req: Request) {
  try {
    authorize(req);
    const s = await readState();
    const rows = [
      [
        "Mapping ID",
        "Subaccount ID",
        "Subaccount name",
        "Card user",
        "Reason",
        "ST Person ID",
      ],
      ...(s.cardMappings || []).map((m) => [
        m.id,
        m.accountId,
        m.accountName ||
          s.records.find((r) => r.accountId === m.accountId)?.account ||
          "",
        m.cardUser,
        m.reason,
        m.personId || "",
      ]),
    ];
    return new Response(
      "\uFEFF" + rows.map((r) => r.map(csv).join(",")).join("\r\n"),
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition":
            'attachment; filename="richmond-card-mappings.csv"',
          "Cache-Control": "no-store",
        },
      },
    );
  } catch {
    return Response.json(
      { error: "Mapping export unavailable" },
      { status: 503 },
    );
  }
}
