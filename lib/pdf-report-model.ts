import { money, type State, type Result, type RecordItem } from "./domain";
import {
  filterResults,
  needsReview,
  isReviewed,
  isReconciled,
  chargeInReport,
  type ReportFilter,
} from "./report";
import { scorecard, periodRange, type Period } from "./scorecard";
import { vendorDisplay } from "./vendor-evidence";
import { poTechnician } from "./po-technician";

export type PDFColumn = {
  label: string;
  width: number;
  align?: "right";
  bold?: boolean;
};
export type PDFTable = {
  title: string;
  columns: PDFColumn[];
  rows: string[][];
  tones?: ("review" | "done" | "plain")[];
  empty: string;
};
export type PDFReport = {
  title: string;
  subtitle: string;
  filters: string[];
  metrics: { label: string; value: string; note: string }[];
  notes: string[];
  tables: PDFTable[];
};

export function reconciliationPDFModel(
  state: State,
  results: Result[],
  filter: ReportFilter,
): PDFReport {
  const byId = new Map(state.records.map((r) => [r.id, r]));
  const groups = filterResults(results, state, filter).map((result) => ({
    result,
    charges: result.charges
      .map((id) => byId.get(id)!)
      .filter((q) => chargeInReport(q, filter, state)),
    pos: result.pos.map((id) => byId.get(id)!),
  }));
  const charges = [
    ...new Map(groups.flatMap((g) => g.charges).map((r) => [r.id, r])).values(),
  ];
  const pos = [
    ...new Map(groups.flatMap((g) => g.pos).map((r) => [r.id, r])).values(),
  ];
  const review = groups.filter((g) => needsReview(g.result.status));
  const partial = groups.some(
    (g) => g.charges.length !== g.result.charges.length,
  );
  const sum = (rows: RecordItem[]) => rows.reduce((n, r) => n + r.amount, 0);
  const filters = [
    `Individual: ${filter.individual || "All individuals"}`,
    `Status: ${filter.status || "All items"}`,
    `Dates: ${filter.from || "Beginning of imported history"} to ${filter.to || "Latest imported date"}`,
    ...(filter.query ? [`Search: ${filter.query}`] : []),
  ];
  return {
    title: "Purchase reconciliation",
    subtitle: "Mr. Handyman of Richmond | Purchase control",
    filters,
    metrics: [
      {
        label: "Card spend",
        value: money(sum(charges)),
        note: `${charges.length} purchases / credits`,
      },
      {
        label: "Related PO value",
        value: money(sum(pos)),
        note: `${pos.length} distinct purchase orders`,
      },
      {
        label: "Needs review",
        value: String(review.length),
        note: `${groups.filter((g) => isReviewed(g.result.status)).length} reviewed groups`,
      },
      {
        label: "Unresolved variance",
        value: money(
          review.reduce((n, g) => n + Math.abs(g.result.difference), 0),
        ),
        note: "Full-group differences",
      },
    ],
    notes: [
      "Totals follow every filter in this export. Credits reduce card spend. Each linked PO is counted once; related PO value is not a technician allocation.",
      "The individual filter selects card purchases by card user and unlinked POs by ST technician. PO technician names come from the PO identity; they do not change the card user. Unavailable names retain their ST technician ID.",
      "Outside card coverage items are retained for reference and excluded from review and variance. A proposed link is not a confirmed match.",
      `${groups.filter((g) => g.result.status === "Matched with flags").length} groups matched with flags: these are reconciled automatically; flags explain uncertainty and do not require individual confirmation.`,
      ...(partial
        ? [
            "Some groups include purchases outside the selected person/date filters. Only selected purchases are shown; PO values and variance describe the full group.",
          ]
        : []),
    ],
    tables: [
      {
        title: `Reconciliation register | ${groups.length} groups`,
        columns: [
          { label: "DATE", width: 68 },
          { label: "VENDOR / SOURCE", width: 173 },
          { label: "CARD USER", width: 106 },
          { label: "CARD USD", width: 78, align: "right", bold: true },
          { label: "PO USD", width: 78, align: "right" },
          { label: "STATUS", width: 111 },
          { label: "PURCHASE ORDER", width: 114 },
        ],
        rows: groups.map(({ result: r, charges: q, pos: p }) => [
          [...new Set((q.length ? q : p).map((x) => x.date))].sort().join("\n"),
          [
            r.vendor,
            ...q.map((x) => x.id),
            ...q
              .filter((x) => x.vendorEvidence)
              .map((x) => `Description: ${x.description}`),
          ].join("\n"),
          [...new Set(q.map((x) => x.cardUser || "Unassigned"))].join("\n") ||
            "No card charge",
          q.length ? money(sum(q)) : "-",
          p.length ? money(sum(p)) : "-",
          [
            r.status,
            ...(r.score ? [`${r.score}% confidence`] : []),
            ...(r.pos.length && r.charges.length
              ? [isReconciled(r.status) ? "Reconciled link" : "Proposed link"]
              : []),
            ...r.flags,
          ].join("\n"),
          p
            .map(
              (x) =>
                `${x.reference || x.id}${x.reference && x.reference !== x.id ? `\n${x.id}` : ""}\nPO technician: ${poTechnician(state, x).name}`,
            )
            .join("\n") || "No linked PO",
        ]),
        tones: groups.map((g) =>
          needsReview(g.result.status)
            ? "review"
            : isReviewed(g.result.status)
              ? "done"
              : "plain",
        ),
        empty: "No reconciliation items match the selected filters.",
      },
    ],
  };
}

export function scorecardPDFModel(
  state: State,
  results: Result[],
  period: Period,
  personId = "all",
): PDFReport {
  const range = periodRange(period),
    data = scorecard(state, results, range);
  const rows = data.rows.filter((r) => personId === "all" || r.id === personId);
  const sum = (
    key:
      | "spend"
      | "poTotal"
      | "vanStock"
      | "chargeCount"
      | "poCount"
      | "vanStockCount",
  ) => rows.reduce((n, r) => n + r[key], 0);
  const ratio = (spend: number, po: number) =>
    po > 0 ? `${((spend / po) * 100).toFixed(1)}%` : "N/A";
  const selectedName =
    personId === "all"
      ? "All people"
      : rows[0]?.name || "Selected person (no activity)";
  const periodLabel =
    period.unit === "year"
      ? String(period.year)
      : period.unit === "month"
        ? new Date(`${range.from}T00:00:00Z`).toLocaleString("en-US", {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
          })
        : `${period.unit === "quarter" ? "Q" : "ISO week "}${period.period}, ${period.year}`;
  const tables: PDFTable[] = [
    {
      title: "Technician / card-user scorecard",
      columns: [
        { label: "PERSON / ST IDENTITY", width: 222 },
        { label: "CARD SPEND", width: 110, align: "right", bold: true },
        { label: "PO TOTAL", width: 110, align: "right" },
        { label: "SPEND / PO", width: 86, align: "right" },
        { label: "VAN STOCK", width: 112, align: "right", bold: true },
        { label: "COUNTS", width: 88 },
      ],
      rows: rows.map((r) => [
        `${r.name}\n${r.kind}\n${r.id}`,
        money(r.spend),
        money(r.poTotal),
        ratio(r.spend, r.poTotal),
        money(r.vanStock),
        `${r.chargeCount} card\n${r.poCount} PO\n${r.vanStockCount} VS`,
      ]),
      empty: "No activity for the selected person and reporting period.",
    },
  ];
  if (personId !== "all") {
    const evidence = data.evidence
      .filter((e) => e.ownerId === personId)
      .sort(
        (a, b) =>
          b.record.date.localeCompare(a.record.date) ||
          a.record.id.localeCompare(b.record.id),
      );
    tables.push({
      title: `Source activity | ${evidence.length} records`,
      columns: [
        { label: "DATE", width: 66 },
        { label: "SOURCE / REFERENCE", width: 145 },
        { label: "VENDOR / DESCRIPTION", width: 209 },
        { label: "AMOUNT USD", width: 100, align: "right", bold: true },
        { label: "VAN STOCK", width: 83 },
        { label: "ATTRIBUTION", width: 125 },
      ],
      rows: evidence.map((e) => [
        e.record.date,
        `${e.record.source === "qbo" ? "QuickBooks" : "ServiceTitan"}\n${e.record.id}\n${e.record.reference}`,
        vendorDisplay(e.record),
        money(e.record.amount),
        e.record.source === "qbo"
          ? "-"
          : e.vanStock
            ? "VAN STOCK"
            : "No VS label",
        e.basis,
      ]),
      empty: "No source activity in this period.",
    });
  }
  return {
    title: "Technician scorecard",
    subtitle: "Mr. Handyman of Richmond | Spend, purchase orders and Van Stock",
    filters: [
      `Person: ${selectedName}`,
      `Period: ${periodLabel}`,
      `Dates: ${range.from} to ${range.to}`,
      `Data: ${data.completeness}`,
    ],
    metrics: [
      {
        label: "Total card spend",
        value: money(sum("spend")),
        note: `${sum("chargeCount")} purchases / credits`,
      },
      {
        label: "Total PO value",
        value: money(sum("poTotal")),
        note: `${sum("poCount")} purchase orders`,
      },
      {
        label: "Spend / PO",
        value: ratio(sum("spend"), sum("poTotal")),
        note: "Card spend divided by PO value",
      },
      {
        label: "Van Stock",
        value: money(sum("vanStock")),
        note: `${sum("vanStockCount")} labeled VS purchase orders`,
      },
    ],
    notes: [
      "Spend uses card-transaction dates; PO and Van Stock totals use PO dates. Refunds reduce spend. A PO is counted once under the recorded attribution basis.",
      `Van Stock requires the ServiceTitan VAN STOCK / VS label or a configured type. ${data.completeness === "Partial period" ? "The selected period extends beyond imported history; these totals are incomplete." : ""}`,
      ...(personId === "all"
        ? [
            "Select an individual in the app to include their source activity in the PDF.",
          ]
        : []),
    ],
    tables,
  };
}
