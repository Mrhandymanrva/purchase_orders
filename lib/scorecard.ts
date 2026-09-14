import { z } from "zod";
import type { RecordItem, Result, State } from "./domain";
import { classifyVanStock, VAN_STOCK_RULE } from "./van-stock";
import { isReconciled } from "./reconciliation-status";
export const periodSchema = z.object({
  unit: z.enum(["week", "month", "quarter", "year"]),
  year: z.number().int().min(2000).max(2100),
  period: z.number().int().min(1).max(53),
});
export type Period = z.infer<typeof periodSchema>;
const day = (d: Date) => d.toISOString().slice(0, 10);
const add = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const firstWeek = (year: number) => {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  return add(jan4, -((jan4.getUTCDay() + 6) % 7));
};
export const weeksInYear = (year: number) =>
  Math.round((+firstWeek(year + 1) - +firstWeek(year)) / (7 * 86400000));
export function periodContaining(date: string, unit: Period["unit"]): Period {
  const d = new Date(date + "T00:00:00Z"),
    month = d.getUTCMonth() + 1;
  if (unit === "week") {
    const thursday = add(d, 3 - ((d.getUTCDay() + 6) % 7)),
      year = thursday.getUTCFullYear();
    return {
      unit,
      year,
      period: Math.floor((+d - +firstWeek(year)) / (7 * 86400000)) + 1,
    };
  }
  return {
    unit,
    year: d.getUTCFullYear(),
    period:
      unit === "month" ? month : unit === "quarter" ? Math.ceil(month / 3) : 1,
  };
}
export function periodRange(input: Period) {
  const p = periodSchema.parse(input);
  let start: Date, end: Date;
  if (p.unit === "week") {
    if (p.period > weeksInYear(p.year))
      throw Error("That ISO week does not exist in the selected year.");
    start = add(firstWeek(p.year), (p.period - 1) * 7);
    end = add(start, 6);
  } else {
    const max = p.unit === "month" ? 12 : p.unit === "quarter" ? 4 : 1;
    if (p.period > max) throw Error("Invalid reporting period.");
    const month =
      p.unit === "month"
        ? p.period - 1
        : p.unit === "quarter"
          ? (p.period - 1) * 3
          : 0;
    const months = p.unit === "month" ? 1 : p.unit === "quarter" ? 3 : 12;
    start = new Date(Date.UTC(p.year, month, 1));
    end = new Date(Date.UTC(p.year, month + months, 0));
  }
  return { from: day(start), to: day(end) };
}
export type ScoreRow = {
  id: string;
  name: string;
  kind: string;
  spend: number;
  chargeCount: number;
  poTotal: number;
  poCount: number;
  vanStock: number;
  vanStockCount: number;
  unknownPoTypeCount: number;
};
export type ScoreEvidence = {
  record: RecordItem;
  ownerId: string;
  owner: string;
  basis: string;
  vanStock: boolean;
  vanStockBasis: string;
  vanStockLabel: string;
  unknownPoType: boolean;
};
export function scorecard(
  state: State,
  results: Result[],
  range: { from: string; to: string },
) {
  const rows = new Map<string, ScoreRow>(),
    evidence: ScoreEvidence[] = [];
  const ensure = (id: string, name: string, kind = "Imported card user") => {
    if (!rows.has(id))
      rows.set(id, {
        id,
        name,
        kind,
        spend: 0,
        chargeCount: 0,
        poTotal: 0,
        poCount: 0,
        vanStock: 0,
        vanStockCount: 0,
        unknownPoTypeCount: 0,
      });
    return rows.get(id)!;
  };
  for (const p of state.directory?.people || [])
    if (p.kind === "technician" && p.active) ensure(p.id, p.name, p.kind);
  function person(id: string) {
    const p = state.directory?.people.find((p) => p.id === id);
    return ensure(
      id,
      p?.name || `ServiceTitan ${id}`,
      p?.kind || "Source technician",
    );
  }
  function chargeOwner(r: RecordItem) {
    if (r.cardPersonId) return person(r.cardPersonId);
    const name = r.cardUser || "Unassigned";
    const matching = (state.directory?.people || []).filter(
      (p) => p.name === name,
    );
    if (matching.length === 1) return person(matching[0].id);
    return ensure(
      `name:${name}`,
      name,
      name === "Unassigned" ? "Unassigned" : "Unlinked ST identity",
    );
  }
  const poLinks = new Map<string, Result>();
  for (const r of results)
    if (isReconciled(r.status)) for (const id of r.pos) poLinks.set(id, r);
  for (const record of state.records) {
    if (record.date < range.from || record.date > range.to) continue;
    const classification = classifyVanStock(record, state);
    let owner: ScoreRow, basis: string;
    if (record.source === "qbo") {
      owner = chargeOwner(record);
      basis = record.ownershipSource || "Imported card user";
      owner.spend += record.amount;
      owner.chargeCount++;
    } else {
      const link = poLinks.get(record.id),
        charges = state.records.filter((q) => link?.charges.includes(q.id)),
        owners = [
          ...new Map(
            charges.map((q) => {
              const p = chargeOwner(q);
              return [p.id, p] as const;
            }),
          ).values(),
        ];
      if (owners.length === 1) {
        owner = owners[0];
        basis = "Reconciled card user";
      } else if (owners.length > 1) {
        owner = ensure("shared", "Shared card users", "Shared / unallocated");
        basis =
          "Reconciled PO spans several card users; counted once in shared total";
      } else if (record.technicianId) {
        owner = person(`technician:${record.technicianId}`);
        basis = "ServiceTitan PO technician (no reconciled card link)";
      } else {
        owner = ensure("unassigned-po", "Unassigned POs", "Unassigned");
        basis = "No ST technician or reconciled card user";
      }
      if (link?.status === "Matched with flags")
        basis += ` (matched with flags: ${link.flags.join("; ")})`;
      owner.poTotal += record.amount;
      owner.poCount++;
      if (classification.unknownType) owner.unknownPoTypeCount++;
    }
    const vanStock = classification.vanStock;
    if (vanStock) {
      owner.vanStock += record.amount;
      owner.vanStockCount++;
    }
    evidence.push({
      record,
      ownerId: owner.id,
      owner: owner.name,
      basis,
      vanStock,
      vanStockBasis: classification.basis,
      vanStockLabel: classification.label,
      unknownPoType: classification.unknownType,
    });
  }
  const ordered = [...rows.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const total = ordered.reduce(
    (a, r) => ({
      ...a,
      spend: a.spend + r.spend,
      chargeCount: a.chargeCount + r.chargeCount,
      poTotal: a.poTotal + r.poTotal,
      poCount: a.poCount + r.poCount,
      vanStock: a.vanStock + r.vanStock,
      vanStockCount: a.vanStockCount + r.vanStockCount,
      unknownPoTypeCount: a.unknownPoTypeCount + r.unknownPoTypeCount,
    }),
    {
      id: "all",
      name: "All people",
      kind: "Total",
      spend: 0,
      chargeCount: 0,
      poTotal: 0,
      poCount: 0,
      vanStock: 0,
      vanStockCount: 0,
      unknownPoTypeCount: 0,
    },
  );
  const completeness =
    state.mode === "demo"
      ? "Sample data"
      : !state.coverage
        ? "No completed sync"
        : range.from < state.coverage.chargesFrom ||
            range.from < state.coverage.posFrom ||
            range.to > state.coverage.through
          ? "Partial period"
          : "Imported period covered";
  return {
    rows: ordered,
    total,
    evidence,
    vanStockConfigured: true,
    vanStockRule: VAN_STOCK_RULE,
    completeness,
    coverage: state.coverage,
  };
}
export function scorecardCSV(
  data: ReturnType<typeof scorecard>,
  range: { from: string; to: string },
  personId = "all",
) {
  const rows: (string | number)[][] = [
    [
      "Person",
      "ST identity",
      "Period from",
      "Period through",
      "Total card spend USD",
      "Card purchases",
      "Total PO USD",
      "PO count",
      "Spend / PO percent",
      "Van Stock USD",
      "Van Stock PO count",
      "POs without label and with unavailable type",
      "Data completeness",
      "Charges imported from",
      "POs imported from",
      "Data through",
      "Van Stock classification rule",
    ],
  ];
  for (const r of data.rows.filter(
    (r) => personId === "all" || r.id === personId,
  ))
    rows.push([
      r.name,
      r.id,
      range.from,
      range.to,
      r.spend / 100,
      r.chargeCount,
      r.poTotal / 100,
      r.poCount,
      r.poTotal > 0 ? Number(((r.spend / r.poTotal) * 100).toFixed(1)) : "",
      data.vanStockConfigured ? r.vanStock / 100 : "Not configured",
      data.vanStockConfigured ? r.vanStockCount : "Not configured",
      r.unknownPoTypeCount,
      data.completeness,
      data.coverage?.chargesFrom || "",
      data.coverage?.posFrom || "",
      data.coverage?.through || "",
      data.vanStockRule,
    ]);
  const cell = (value: string | number) => {
    const s = String(value);
    return (
      '"' +
      (typeof value === "string" && /^[=+\-@\t\r]/.test(s)
        ? "'" + s
        : s
      ).replace(/"/g, '""') +
      '"'
    );
  };
  return "\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
}
