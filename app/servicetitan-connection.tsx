"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { State } from "@/lib/domain";

export default function ServiceTitanConnection({
  state,
  onChanged,
}: {
  state: State;
  onChanged: (state: State) => void;
}) {
  const st = state.serviceTitan;
  const [selected, setSelected] = useState<string[]>(st?.businessUnitIds || []);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const reasonInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setSelected(st?.businessUnitIds || []);
  }, [state.revision]);

  async function request(
    type: "discover-st-business-units" | "save-st-business-units",
  ) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          revision: state.revision,
          ...(type === "save-st-business-units"
            ? { businessUnitIds: selected, reason: reason.trim() }
            : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw Error(data.error || "Could not update ServiceTitan setup.");
      onChanged(data);
      setReason("");
      setMessage(
        type === "discover-st-business-units"
          ? "Business units loaded. Select Richmond below and save the PO import scope."
          : "PO import scope saved. Run Sync & reconcile to import purchases and POs.",
      );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Could not update ServiceTitan setup.",
      );
    } finally {
      setBusy(false);
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!selected.length) {
      setMessage("Select at least one business unit.");
      return;
    }
    if (reason.trim().length < 5) {
      setMessage(
        "Enter a reason of at least 5 characters, such as Initial Richmond PO scope.",
      );
      reasonInput.current?.focus();
      return;
    }
    void request("save-st-business-units");
  }
  return (
    <section className="panel account-mappings qbo-onboarding">
      <h2>ServiceTitan PO import scope</h2>
      <p>
        Choose the business units whose purchase orders belong in this
        workspace. Only active technicians and employees are imported for card
        assignments.
      </p>
      <button
        disabled={busy}
        onClick={() => request("discover-st-business-units")}
      >
        Load ServiceTitan business units
      </button>
      {st?.discoveredAt && (
        <form className="qbo-card-picker" onSubmit={save} noValidate>
          <p>
            Selected for import:{" "}
            <strong>
              {st.businessUnits
                .filter((u) => st.businessUnitIds?.includes(u.id))
                .map((u) => u.name)
                .join(", ") || "Not saved yet"}
            </strong>
          </p>
          <div className="qbo-card-list">
            {st.businessUnits
              .filter((u) => u.active || selected.includes(u.id))
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((unit) => (
                <label key={unit.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(unit.id)}
                    disabled={busy}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, unit.id]
                          : selected.filter((id) => id !== unit.id),
                      )
                    }
                  />
                  <span>
                    {unit.name}
                    {!unit.active ? " (inactive — remove from selection)" : ""}
                  </span>
                </label>
              ))}
          </div>
          {!st.businessUnits.some((u) => u.active) && (
            <p>No active business units were returned by ServiceTitan.</p>
          )}
          <label className="field">
            Reason for this scope (required)
            <input
              ref={reasonInput}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              minLength={5}
              maxLength={500}
              disabled={busy}
              placeholder="e.g. Initial Richmond PO scope"
              aria-describedby="st-scope-help"
            />
          </label>
          <p id="st-scope-help">
            Enter at least 5 characters. Changes are recorded in the audit log
            and apply on the next successful sync.
          </p>
          <button type="submit" disabled={busy}>
            {busy ? "Working…" : "Save PO import scope"}
          </button>
        </form>
      )}
      <p role="status">{busy ? "Working…" : message}</p>
    </section>
  );
}
