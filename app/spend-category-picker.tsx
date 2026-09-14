"use client";
import { useState } from "react";
import type { State, Result } from "@/lib/domain";
import { spendCategories, spendCategoryLabel } from "@/lib/spend-categories";

export default function SpendCategoryPicker({
  state,
  result,
  busy,
  onSave,
  onApplied,
}: {
  state: State;
  result: Result;
  busy: boolean;
  onSave: (body: object) => Promise<boolean>;
  onApplied: () => void;
}) {
  const chargeId = result.charges[0];
  const prior = state.decisions
    .slice()
    .reverse()
    .find((d) => d.action === "categorize" && d.charges.includes(chargeId));
  const [categoryId, setCategoryId] = useState(
    result.categoryId || prior?.categoryId || "",
  );
  const [error, setError] = useState("");
  const options = spendCategories(state);
  const changedSource = !!prior && !result.categoryId;
  const selected = options.find((c) => c.id === categoryId);
  const canSave = categoryId
    ? !!selected?.active && (categoryId !== result.categoryId || changedSource)
    : !!prior;
  return (
    <section className="spend-category-picker">
      <h3>Spend category</h3>
      <p className="hint">
        For a purchase that does not need a PO, choose a category and save. This
        applies to this purchase only; it stays in spend totals and reports.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          if (!canSave) return;
          const saved = await onSave({
            type: "categorize-spend",
            chargeId,
            categoryId: categoryId || null,
          });
          if (saved) onApplied();
          else
            setError(
              "Category was not saved. See the error message and retry.",
            );
        }}
      >
        <label className="field">
          Spend category
          <select
            aria-label="Spend category"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">Uncategorized</option>
            {options
              .filter((c) => c.active || c.id === categoryId)
              .map((c) => (
                <option key={c.id} value={c.id} disabled={!c.active}>
                  {c.name}
                  {!c.active ? " (archived)" : ""}
                </option>
              ))}
          </select>
        </label>
        {result.categoryId && (
          <p className="hint">Saved: {spendCategoryLabel(state, result)}</p>
        )}
        {changedSource && (
          <p className="notice">
            The source changed since this category was saved. Review the
            purchase and save again to apply it to the current record.
          </p>
        )}
        {result.pos.length > 0 && categoryId && (
          <p className="notice">
            Saving a category marks this purchase as No PO required and releases
            its linked PO for reconciliation.
          </p>
        )}
        <p className="hint">
          Saving marks this purchase as No PO required and refreshes
          reconciliation. Choose Uncategorized and save to return it to normal
          matching. Manage the choices in Rules &amp; scoring.
        </p>
        <button className="primary" disabled={busy || !canSave}>
          {busy ? "Saving…" : "Save category"}
        </button>
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
