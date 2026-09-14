import type { RecordItem, Rule } from "./domain";
// Complete descriptor equality: case and repeated whitespace are insignificant.
// Punctuation and store numbers are retained; this is never substring matching.
export const descriptionKey = (value: string) =>
  value.trim().replace(/\s+/g, " ").toLowerCase();
export function exclusionDraft(record: RecordItem) {
  const matchField = record.vendorMissing
    ? ("description" as const)
    : ("vendor" as const);
  const pattern = (
    record.vendorMissing
      ? record.source === "qbo"
        ? record.description
        : ""
      : record.vendor
  ).trim();
  if (!pattern || pattern.length > 500) return null;
  return {
    type: "no-po" as const,
    matchField,
    pattern,
    target: "",
    maxCents: null,
    description:
      `No PO required for ${matchField === "description" ? "QuickBooks description" : "vendor"}: ${pattern}`.slice(
        0,
        500,
      ),
  };
}
export const ruleMatchField = (rule: Pick<Rule, "matchField">) =>
  rule.matchField || "vendor";
