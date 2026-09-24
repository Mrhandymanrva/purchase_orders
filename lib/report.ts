import { jobContext, purchaseOrderLabel } from "./job-context";
import { z } from "zod";
import { spendCategoryLabel } from "./spend-categories";
import type { State, Result, RecordItem } from "./domain";
import { vendorBasis } from "./vendor-evidence";
import {
  isReconciled,
  needsReview,
  statusLabel,
} from "./reconciliation-status";
import { ENGINE_VERSION } from "./engine";
import {
  individualMatches,
  poTechnician,
  poTechnicianLabel,
} from "./po-technician";
export { isReconciled, isReviewed, needsReview } from "./reconciliation-status";
export function cardUsers(state: State, result: Result) {
  return Array.from(
    new Set(
      result.charges.map(
        (id) =>
          state.records.find((r) => r.id === id)?.cardUser || "Unassigned",
      ),
    ),
  ).sort();
}
export function ownershipLabel(state: State, result: Result) {
  return cardUsers(state, result).join(", ") || "No card charge";
}
export const reportColumns = [
  { key: "vendor", label: "Vendor / transaction" },
  { key: "cardUser", label: "Card user" },
  { key: "poTechnician", label: "PO technician" },
  { key: "customer", label: "Customer" },
  { key: "jobId", label: "Job number / ID" },
  { key: "date", label: "Date" },
  { key: "amount", label: "Amount" },
  { key: "status", label: "Status" },
  { key: "category", label: "Spend category" },
  { key: "score", label: "Confidence" },
  { key: "po", label: "Purchase order" },
] as const;
export const reportSortSchema = z.object({
  sortBy: z
    .enum([
      "vendor",
      "cardUser",
      "poTechnician",
      "customer",
      "jobId",
      "date",
      "amount",
      "status",
      "category",
      "score",
      "po",
    ])
    .default("date"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
});
export type ReportSort = z.infer<typeof reportSortSchema>;
export function nextReportSort(
  current: ReportSort,
  key: ReportSort["sortBy"],
): ReportSort {
  return {
    sortBy: key,
    sortDirection:
      current.sortBy === key
        ? current.sortDirection === "asc"
          ? "desc"
          : "asc"
        : ["date", "amount", "score"].includes(key)
          ? "desc"
          : "asc",
  };
}
export type ReportFilter = Partial<ReportSort> & {
  individual?: string;
  status?: string;
  query?: string;
  from?: string;
  to?: string;
};
export function chargeInReport(q: RecordItem, f: ReportFilter, state?: State) {
  return (
    individualMatches(
      state,
      q.cardPersonId,
      q.cardUser || "Unassigned",
      f.individual,
    ) &&
    (!f.from || q.date >= f.from) &&
    (!f.to || q.date <= f.to)
  );
}
export function poInReport(state: State, po: RecordItem, f: ReportFilter) {
  const person = poTechnician(state, po);
  return (
    individualMatches(state, person.id, person.name, f.individual) &&
    (!f.from || po.date >= f.from) &&
    (!f.to || po.date <= f.to)
  );
}
// Use the same filtered group amount in the register and its sorting. Exports
// expand a group into source rows while retaining this group order.
export function reportAmount(
  state: State,
  result: Result,
  filter: ReportFilter,
) {
  return result.charges.length
    ? state.records
        .filter(
          (q) =>
            result.charges.includes(q.id) && chargeInReport(q, filter, state),
        )
        .reduce((n, q) => n + q.amount, 0)
    : result.amount;
}
const collator = new Intl.Collator("en-US", {
  numeric: true,
  sensitivity: "base",
});
function sortResults(results: Result[], state: State, filter: ReportFilter) {
  const { sortBy, sortDirection } = reportSortSchema.parse(filter);
  const value = (r: Result): string | number | null => {
    switch (sortBy) {
      case "vendor":
        return r.vendor;
      case "cardUser":
        return ownershipLabel(state, r);
      case "poTechnician":
        return r.pos.length ? poTechnicianLabel(state, r) : null;
      case "customer":
        return jobContext(state, r, "customerName") || null;
      case "jobId":
        return (
          jobContext(state, r, "jobNumber") ||
          jobContext(state, r, "jobId") ||
          null
        );
      case "date":
        return r.date;
      case "amount":
        return reportAmount(state, r, filter);
      case "status":
        return statusLabel(r.status);
      case "category":
        return spendCategoryLabel(state, r) || null;
      case "score":
        return r.score > 0 ? r.score : null;
      case "po":
        return r.pos.length ? purchaseOrderLabel(state, r) : null;
    }
  };
  return results
    .map((result) => ({ result, value: value(result) }))
    .sort((a, b) => {
      // Missing scores / POs stay at the bottom in either direction.
      if (a.value === null && b.value !== null) return 1;
      if (a.value !== null && b.value === null) return -1;
      const compared =
        a.value === null || b.value === null
          ? 0
          : typeof a.value === "number" && typeof b.value === "number"
            ? a.value - b.value
            : collator.compare(String(a.value), String(b.value));
      return (
        compared * (sortDirection === "asc" ? 1 : -1) ||
        collator.compare(a.result.id, b.result.id) ||
        a.result.id.localeCompare(b.result.id, "en-US")
      );
    })
    .map((row) => row.result);
}
export function filterResults(
  results: Result[],
  state: State,
  f: ReportFilter,
) {
  const selected = results.filter((r) => {
    const relevant = r.charges.length
      ? state.records
          .filter((q) => r.charges.includes(q.id))
          .some((q) => chargeInReport(q, f, state))
      : state.records
          .filter((p) => r.pos.includes(p.id))
          .some((p) => poInReport(state, p, f));
    return (
      relevant &&
      (!f.status ||
        f.status === "All items" ||
        (f.status === "Needs review"
          ? needsReview(r.status)
          : f.status === "Matched"
            ? isReconciled(r.status)
            : r.status === f.status)) &&
      (!f.query ||
        `${r.vendor} ${r.id} ${r.pos.join(" ")} ${r.charges.join(" ")} ${ownershipLabel(state, r)} ${poTechnicianLabel(state, r)} ${spendCategoryLabel(state, r)} ${jobContext(state, r, "customerName")} ${jobContext(state, r, "jobId")} ${jobContext(state, r, "jobNumber")} ${purchaseOrderLabel(state, r)}`
          .toLowerCase()
          .includes(f.query.toLowerCase()))
    );
  });
  return sortResults(selected, state, f);
}
function cell(value: string | number) {
  const s = String(value);
  return (
    '"' +
    (typeof value === "string" && /^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(
      /"/g,
      '""',
    ) +
    '"'
  );
}
export function reportCSV(
  state: State,
  results: Result[],
  filter: ReportFilter,
) {
  const selected = filterResults(results, state, filter);
  const rows: (string | number)[][] = [
    [
      "Card user",
      "Ownership source",
      "QuickBooks subaccount",
      "QuickBooks subaccount ID",
      "Charge ID",
      "Charge date",
      "Vendor",
      "Amount USD",
      "Linked PO IDs",
      "Link state",
      "Reconciliation status",
      "Confidence percent",
      "QuickBooks description",
      "Vendor evidence",
      "Merchant recognition rule",
      "Flags",
      "Match evidence",
      "Engine version",
      "PO technician",
      "ST technician ID",
      "Spend category",
      "Customer name",
      "Job ID",
      "Job number",
      "Linked PO numbers",
    ],
  ];
  for (const r of selected) {
    for (const id of r.charges) {
      const q = state.records.find((q) => q.id === id)!;
      const user = q.cardUser || "Unassigned";
      if (!chargeInReport(q, filter, state)) continue;
      rows.push([
        user,
        q.ownershipSource || "Unassigned",
        q.account,
        q.accountId || "",
        q.id,
        q.date,
        q.vendor,
        q.amount / 100,
        r.pos.join("; "),
        r.pos.length
          ? isReconciled(r.status)
            ? "Reconciled"
            : "Proposed — review required"
          : "No linked PO",
        statusLabel(r.status),
        r.score,
        q.description,
        vendorBasis(q),
        q.vendorEvidence?.rule || "",
        r.flags.join("; "),
        r.reasons.join(" "),
        ENGINE_VERSION,
        r.pos.length ? poTechnicianLabel(state, r) : "",
        r.pos
          .map(
            (id) => state.records.find((p) => p.id === id)?.technicianId || "",
          )
          .join("; "),
        spendCategoryLabel(state, r),
        jobContext(state, r, "customerName"),
        jobContext(state, r, "jobId"),
        jobContext(state, r, "jobNumber"),
        purchaseOrderLabel(state, r),
      ]);
    }
    if (!r.charges.length)
      rows.push([
        "No card charge",
        "",
        "",
        "",
        "",
        r.date,
        r.vendor,
        0,
        r.pos.join("; "),
        "Unlinked PO",
        statusLabel(r.status),
        r.score,
        "",
        "ServiceTitan vendor",
        "",
        r.flags.join("; "),
        r.reasons.join(" "),
        ENGINE_VERSION,
        poTechnicianLabel(state, r),
        r.pos
          .map(
            (id) => state.records.find((p) => p.id === id)?.technicianId || "",
          )
          .join("; "),
        spendCategoryLabel(state, r),
        jobContext(state, r, "customerName"),
        jobContext(state, r, "jobId"),
        jobContext(state, r, "jobNumber"),
        purchaseOrderLabel(state, r),
      ]);
  }
  return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
}

// Totals describe unmatched, unresolved records in the current table scope.
export function unmatchedTotals(
  results: Result[],
  state: State,
  filter: ReportFilter,
) {
  let poCents = 0,
    chargeCents = 0;
  for (const result of filterResults(results, state, filter)) {
    if (
      result.status === "No PO required" ||
      result.status === "Dismissed" ||
      isReconciled(result.status)
    )
      continue;
    if (!result.charges.length)
      poCents += state.records
        .filter(
          (p) => result.pos.includes(p.id) && poInReport(state, p, filter),
        )
        .reduce((sum, p) => sum + p.amount, 0);
    if (!result.pos.length) chargeCents += reportAmount(state, result, filter);
  }
  return { poCents, chargeCents, differenceCents: poCents - chargeCents };
}
