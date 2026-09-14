"use client";
import { useState } from "react";
import type { RecordItem, State } from "@/lib/domain";
import { exclusionDraft, ruleMatchField } from "@/lib/vendor-rule";
import { sameRuleMatch } from "@/lib/engine";

export default function VendorExclusionRule({
  state,
  record,
  busy,
  error,
  onSave,
  onApplied,
}: {
  state: State;
  record: RecordItem;
  busy: boolean;
  error: string;
  onSave: (body: object) => Promise<boolean>;
  onApplied: () => void;
}) {
  const draft = exclusionDraft(record);
  const existing = draft
    ? state.rules.find((r) => sameRuleMatch(r, draft, state.rules))
    : undefined;
  const [noLimit, setNoLimit] = useState(existing?.maxCents == null);
  const [limit, setLimit] = useState(
    String((existing?.maxCents ?? Math.max(0, record.amount)) / 100),
  );
  const amount = Number(limit);
  const validLimit =
    noLimit ||
    (limit.trim() !== "" &&
      Number.isFinite(amount) &&
      amount >= 0 &&
      amount <= 100000);
  if (!draft)
    return (
      <section>
        <h3>Vendor rule</h3>
        <p>
          A vendor name or usable QuickBooks description is needed to create an
          exclusion.
        </p>
      </section>
    );
  const description = ruleMatchField(draft) === "description";
  return (
    <section className="vendor-rule">
      <h3>Vendor rule</h3>
      <details>
        <summary>Create vendor exclusion rule</summary>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!validLimit) return;
            const saved = await onSave({
              type: "save-vendor-exclusion",
              approve: true,
              recordId: record.id,
              maxCents: noLimit ? null : Math.round(amount * 100),
            });
            if (saved) onApplied();
          }}
        >
          <p>
            <strong>No PO required</strong>
          </p>
          <label>
            {description ? "Exact QuickBooks description" : "Vendor"}
          </label>
          <p className="rule-pattern">{draft.pattern}</p>
          <p className="hint">
            {description
              ? "Applies to purchases whose imported QuickBooks payee name is unavailable and whose full description matches this text, ignoring case and extra spaces. Store numbers and punctuation must match."
              : "Applies to purchases from this vendor across all cards, using your approved vendor aliases."}
          </p>
          <label className="rule-limit">
            <input
              type="checkbox"
              checked={noLimit}
              onChange={(e) => setNoLimit(e.target.checked)}
            />{" "}
            No amount limit
          </label>
          {!noLimit && (
            <label className="field">
              Maximum purchase amount ($)
              <input
                type="number"
                min="0"
                max="100000"
                step="0.01"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                required
              />
            </label>
          )}
          {existing && (
            <p className="hint">
              {existing.approved
                ? "An approved rule already exists. Saving updates it."
                : "A pending suggestion exists. Saving approves this rule with the settings above."}
            </p>
          )}
          <p className="hint">
            Saving approves the rule and refreshes reconciliation for current
            imports. It also applies to future imports. Purchases remain in
            reports; refunds and possible duplicates still need review.
          </p>
          <button className="primary" disabled={busy || !validLimit}>
            {busy ? "Applying rule…" : "Save and apply rule"}
          </button>
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
        </form>
      </details>
    </section>
  );
}
