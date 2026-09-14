import type { State, Result } from "./domain";
import { vendorBasis } from "./vendor-evidence";
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
export type ReportFilter = {
  individual?: string;
  status?: string;
  query?: string;
  from?: string;
  to?: string;
};
export const isReviewed = (s: string) =>
  ["Matched", "Confirmed", "No PO required", "Dismissed"].includes(s);
export const needsReview = (status: string) =>
  !isReviewed(status) && status !== "Outside card coverage";
export function filterResults(
  results: Result[],
  state: State,
  f: ReportFilter,
) {
  return results.filter((r) => {
    const relevant = r.charges.length
      ? state.records
          .filter((q) => r.charges.includes(q.id))
          .some(
            (q) =>
              (!f.individual ||
                f.individual === "All individuals" ||
                (q.cardUser || "Unassigned") === f.individual) &&
              (!f.from || q.date >= f.from) &&
              (!f.to || q.date <= f.to),
          )
      : (!f.individual || f.individual === "All individuals") &&
        (!f.from || r.date >= f.from) &&
        (!f.to || r.date <= f.to);
    return (
      relevant &&
      (!f.status ||
        f.status === "All items" ||
        (f.status === "Needs review"
          ? needsReview(r.status)
          : r.status === f.status)) &&
      (!f.query ||
        `${r.vendor} ${r.id} ${r.pos.join(" ")} ${r.charges.join(" ")} ${ownershipLabel(state, r)}`
          .toLowerCase()
          .includes(f.query.toLowerCase()))
    );
  });
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
    ],
  ];
  for (const r of selected) {
    for (const id of r.charges) {
      const q = state.records.find((q) => q.id === id)!;
      const user = q.cardUser || "Unassigned";
      if (
        filter.individual &&
        filter.individual !== "All individuals" &&
        filter.individual !== user
      )
        continue;
      if (
        (filter.from && q.date < filter.from) ||
        (filter.to && q.date > filter.to)
      )
        continue;
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
          ? ["Matched", "Confirmed"].includes(r.status)
            ? "Reconciled"
            : "Proposed — review required"
          : "No linked PO",
        r.status,
        r.score,
        q.description,
        vendorBasis(q),
        q.vendorEvidence?.rule || "",
      ]);
    }
    if (
      !r.charges.length &&
      (!filter.individual || filter.individual === "All individuals")
    )
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
        r.status,
        r.score,
        "",
        "ServiceTitan vendor",
        "",
      ]);
  }
  return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
}
