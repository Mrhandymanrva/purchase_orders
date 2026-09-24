"use client";
import { useState } from "react";
import { money, type State, type Result } from "@/lib/domain";
import { isReviewed } from "@/lib/report";

export default function ManualMatch({
  state,
  results,
  active,
  busy,
  onSave,
  onApplied,
}: {
  state: State;
  results: Result[];
  active: Result;
  busy: boolean;
  onSave: (body: object) => Promise<boolean>;
  onApplied: () => void;
}) {
  const [poId, setPoId] = useState(active.pos[0] || "");
  const [chargeIds, setChargeIds] = useState(active.charges);
  const [search, setSearch] = useState("");
  const [poSearch, setPoSearch] = useState("");
  const available = new Set(
    results
      .filter((r) => r.id === active.id || !isReviewed(r.status))
      .flatMap((r) => [...r.charges, ...r.pos]),
  );
  const charges = state.records.filter(
    (r) => r.source === "qbo" && available.has(r.id),
  );
  const pos = state.records.filter(
    (r) => r.source === "st" && available.has(r.id),
  );
  const matches = (r: State["records"][number], query: string) =>
    `${r.id} ${r.vendor} ${r.description} ${r.date} ${r.cardUser || ""} ${r.reference}`
      .toLowerCase()
      .includes(query.toLowerCase());
  const total = charges
    .filter((r) => chargeIds.includes(r.id))
    .reduce((n, r) => n + r.amount, 0);
  const po = pos.find((r) => r.id === poId);
  return (
    <div>
      <p>
        Select one PO and one or more charges. Open an existing confirmed match
        to add further charges to that PO.
      </p>
      <label className="field">
        Find purchase order
        <input
          value={poSearch}
          onChange={(e) => setPoSearch(e.target.value)}
          placeholder="Vendor, PO ID, reference or date"
        />
      </label>
      <label className="field">
        Purchase order
        <select
          value={poId}
          disabled={busy}
          onChange={(e) => setPoId(e.target.value)}
        >
          <option value="">Select a PO…</option>
          {pos
            .filter((r) => r.id === poId || matches(r, poSearch))
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.vendor} · {r.id} · {r.date} · {money(r.amount)}
              </option>
            ))}
        </select>
      </label>
      <label className="field">
        Find charges
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Vendor, card user, charge ID or date"
        />
      </label>
      <p className="muted">
        Available charges across all dates and people. Selected charges stay
        visible.
      </p>
      <div className="match-options" role="group" aria-label="Charges to match">
        {charges
          .filter((r) => chargeIds.includes(r.id) || matches(r, search))
          .map((r) => (
            <label className="match-option" key={r.id}>
              <input
                type="checkbox"
                disabled={busy}
                checked={chargeIds.includes(r.id)}
                onChange={(e) =>
                  setChargeIds((ids) =>
                    e.target.checked
                      ? [...ids, r.id]
                      : ids.filter((id) => id !== r.id),
                  )
                }
              />
              <span>
                <strong>
                  {r.vendor} · {money(r.amount)}
                </strong>
                <small>
                  {r.date} · {r.cardUser || "Unassigned"} · {r.id}
                </small>
              </span>
            </label>
          ))}
        {!charges.length && <p>No available charges.</p>}
      </div>
      <div className="match-summary" aria-live="polite">
        <div>
          {chargeIds.length} selected charges: <strong>{money(total)}</strong>
        </div>
        <div>
          PO total: <strong>{po ? money(po.amount) : "Select a PO"}</strong>
        </div>
        <div>
          Remaining · PO minus charges:{" "}
          <strong>{po ? money(po.amount - total) : "—"}</strong>
        </div>
        {po && po.amount !== total && (
          <p>
            The amounts differ. Confirm only if you have reviewed this remaining
            balance.
          </p>
        )}
      </div>
      <button
        className="primary"
        disabled={busy || !po || !chargeIds.length || chargeIds.length > 100}
        onClick={async () => {
          if (
            await onSave({
              type: "decision",
              resultId: active.id,
              action: "confirm",
              poIds: [poId],
              chargeIds,
            })
          )
            onApplied();
        }}
      >
        Confirm reconciliation
      </button>
    </div>
  );
}
