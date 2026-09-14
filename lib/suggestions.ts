import { normalize } from "./engine";
import type { State, Result, Rule } from "./domain";
// Only proposes a policy for human consideration; recurrence is not proof of exemption.
export function suggestRules(
  state: State,
  results: Result[],
): Omit<Rule, "id">[] {
  const groups = new Map<string, typeof state.records>();
  for (const r of results.filter((r) => r.status === "Missing PO"))
    for (const id of r.charges) {
      const q = state.records.find((q) => q.id === id)!;
      if (q.amount <= 0 || q.vendorMissing) continue;
      const key = normalize(q.vendor, state.rules);
      groups.set(key, [...(groups.get(key) || []), q]);
    }
  return [...groups.entries()].flatMap(([key, records]) => {
    if (
      new Set(records.map((r) => r.date)).size < 3 ||
      state.rules.some(
        (r) =>
          r.type === "no-po" &&
          r.matchField !== "description" &&
          normalize(r.pattern, state.rules) === key,
      )
    )
      return [];
    return [
      {
        type: "no-po" as const,
        pattern: records[0].vendor,
        target: "",
        maxCents: Math.max(...records.map((r) => r.amount)),
        approved: false,
        description: `Review suggestion: ${records.length} unmatched purchases on at least 3 dates. Confirm the expense category is exempt before approving; recurrence alone is not evidence.`,
      },
    ];
  });
}
