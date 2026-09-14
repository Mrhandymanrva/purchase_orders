import { z } from "zod";
import type { State, SpendCategory, Decision } from "./domain";
import { spendCategories } from "./spend-categories";
import { fingerprint, reconcile, ENGINE_VERSION } from "./engine";
import { appendAudit } from "./store";
export const spendCategorySchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .transform((v) => v.replace(/\s+/g, " ")),
  active: z.boolean(),
});
export function saveSpendCategories(
  state: State,
  categories: SpendCategory[],
  actor: string,
) {
  const before = spendCategories(state);
  const nameKey = (v: string) => v.normalize("NFKC").toLowerCase();
  if (
    new Set(categories.map((c) => c.id)).size !== categories.length ||
    new Set(categories.map((c) => nameKey(c.name))).size !== categories.length
  )
    throw Error("Each spend category needs a unique name and ID.");
  if (before.some((c) => !categories.some((next) => next.id === c.id)))
    throw Error(
      "Turn off Available to archive a category. Existing category IDs cannot be removed.",
    );
  state.spendCategories = categories;
  appendAudit(state, actor, "Spend categories updated", {
    before,
    after: categories,
  });
}
export function categorizeSpend(
  state: State,
  chargeId: string,
  categoryId: string | null,
  actor: string,
  asOf: string,
) {
  const charge = state.records.find(
    (r) => r.id === chargeId && r.source === "qbo",
  );
  if (!charge)
    throw Error("Card purchase no longer exists. Refresh and retry.");
  const category =
    categoryId === null
      ? undefined
      : spendCategories(state).find((c) => c.id === categoryId && c.active);
  if (categoryId !== null && !category)
    throw Error("Choose an available spend category.");
  const before = state.decisions.filter((d) => d.charges.includes(charge.id));
  const evaluate = () =>
    reconcile(
      state.records,
      state.config,
      state.rules,
      asOf,
      state.decisions,
      state.coverage,
    );
  const priorResults = evaluate();
  if (category) {
    // The explicit per-purchase exception replaces prior review of this charge.
    // Related POs return to ordinary matching; source records are never deleted.
    state.decisions = state.decisions.filter(
      (d) => !d.charges.includes(charge.id),
    );
    const decision: Decision = {
      resultId: JSON.stringify([[charge.id], []]),
      fingerprint: fingerprint(state.records, [charge.id]),
      action: "categorize",
      categoryId: category.id,
      categoryName: category.name,
      reason: "No PO required for this individual purchase: " + category.name,
      actor,
      at: new Date().toISOString(),
      charges: [charge.id],
      pos: [],
    };
    state.decisions.push(decision);
  } else {
    state.decisions = state.decisions.filter(
      (d) => !(d.action === "categorize" && d.charges.includes(charge.id)),
    );
  }
  appendAudit(
    state,
    actor,
    category ? "Spend categorized" : "Spend category cleared",
    {
      chargeId: charge.id,
      before,
      after: state.decisions.filter((d) => d.charges.includes(charge.id)),
      reconciliation: {
        engine: ENGINE_VERSION,
        asOf,
        sourceFingerprint: fingerprint(
          state.records,
          state.records.map((r) => r.id),
        ),
        before: priorResults.find((r) => r.charges.includes(charge.id)),
        results: evaluate(),
      },
    },
  );
}
