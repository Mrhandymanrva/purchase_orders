"use client";
import { useEffect, useState } from "react";
import type { State, CardMapping } from "@/lib/domain";
import { accountOptions } from "@/lib/directory";
import CardMappingUpload from "./card-mapping-upload";
type Save = (body: object) => Promise<boolean>;
function MappingRow({
  state,
  initial,
  busy,
  onSave,
}: {
  state: State;
  initial: Partial<CardMapping>;
  busy: boolean;
  onSave: Save;
}) {
  const initialDraft = () => ({
    accountId: initial.accountId || "",
    person:
      initial.personId || (initial.cardUser ? `name:${initial.cardUser}` : ""),
    from:
      initial.from ||
      (state.mode === "demo"
        ? "2026-09-01"
        : new Date().toISOString().slice(0, 10)),
    through: initial.through || "",
    reason: initial.reason || "",
  });
  const [draft, setDraft] = useState(initialDraft),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!dirty) setDraft(initialDraft());
  }, [
    initial.accountId,
    initial.cardUser,
    initial.personId,
    initial.from,
    initial.through,
    initial.reason,
    dirty,
  ]);
  const update = (field: string, value: string) => {
    setDraft((d) => ({ ...d, [field]: value }));
    setDirty(true);
    setError("");
  };
  const people = state.directory?.people || [],
    accounts = accountOptions(state),
    label = initial.id || initial.accountId || "new";
  async function save() {
    const person = people.find((p) => p.id === draft.person);
    const cardUser = person?.name || draft.person.replace(/^name:/, "");
    if (
      !draft.accountId ||
      !cardUser ||
      !draft.from ||
      draft.reason.trim().length < 5
    ) {
      setError(
        "Choose an account and person, start date, and a reason (5+ characters).",
      );
      return;
    }
    const ok = await onSave({
      type: "save-card-mapping",
      mapping: {
        id: initial.id,
        accountId: draft.accountId,
        cardUser,
        personId: person?.id,
        from: draft.from,
        through: draft.through || undefined,
        reason: draft.reason,
      },
    });
    if (ok) setDirty(false);
  }
  return (
    <tr className={dirty ? "mapping-dirty" : ""}>
      <td>
        <select
          aria-label={`QuickBooks account ${label}`}
          value={draft.accountId}
          disabled={busy}
          onChange={(e) => update("accountId", e.target.value)}
        >
          <option value="">Select subaccount</option>
          {accounts
            .filter((a) => a.active || a.id === draft.accountId)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.id}
                {!a.active ? " (inactive)" : ""}
              </option>
            ))}
        </select>
        <small className="block">{draft.accountId || "New assignment"}</small>
      </td>
      <td>
        <select
          aria-label={`ServiceTitan person ${label}`}
          value={draft.person}
          disabled={busy}
          onChange={(e) => update("person", e.target.value)}
        >
          <option value="">Select person</option>
          {draft.person.startsWith("name:") && (
            <option value={draft.person}>
              {draft.person.slice(5)} · imported name
            </option>
          )}
          {people
            .filter((p) => p.active || p.id === draft.person)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.kind} #{p.sourceId}
                {!p.active ? " (inactive)" : ""}
              </option>
            ))}
        </select>
        <small className="block">
          {draft.person && !draft.person.startsWith("name:")
            ? draft.person
            : "Choose an ST identity to verify the link"}
        </small>
      </td>
      <td>
        <input
          aria-label={`Effective from ${label}`}
          type="date"
          value={draft.from}
          disabled={busy}
          onChange={(e) => update("from", e.target.value)}
        />
      </td>
      <td>
        <input
          aria-label={`Effective through ${label}`}
          type="date"
          value={draft.through}
          disabled={busy}
          onChange={(e) => update("through", e.target.value)}
        />
        <small className="block">Blank = ongoing</small>
      </td>
      <td>
        <input
          aria-label={`Mapping reason ${label}`}
          value={draft.reason}
          maxLength={500}
          disabled={busy}
          placeholder="Why this assignment?"
          onChange={(e) => update("reason", e.target.value)}
        />
      </td>
      <td>
        <span
          className={
            "badge " + (dirty ? "warning" : initial.id ? "neutral" : "warning")
          }
        >
          {dirty ? "Unsaved" : initial.id ? "Saved" : "Unmapped"}
        </span>
        <button
          className="mapping-save"
          disabled={busy || (!dirty && !!initial.id)}
          onClick={save}
        >
          Save row
        </button>
        {error && (
          <small className="field-error" role="alert">
            {error}
          </small>
        )}
      </td>
    </tr>
  );
}
export default function CardMappings({
  state,
  busy,
  onSave,
  onImported,
}: {
  state: State;
  busy: boolean;
  onSave: Save;
  onImported: (s: State) => void;
}) {
  const [newRows, setNewRows] = useState<number[]>([]);
  const accounts = accountOptions(state);
  const mappings = state.cardMappings || [];
  const unmapped = accounts.filter(
    (a) => a.active && !mappings.some((m) => m.accountId === a.id),
  );
  return (
    <section className="panel account-mappings">
      <div className="grid-heading">
        <div>
          <h2>Card assignments</h2>
          <p>
            All {mappings.length} saved assignments and {unmapped.length}{" "}
            unmapped subaccounts in one editable grid.
          </p>
        </div>
        <div className="heading-actions">
          <button
            disabled={busy}
            onClick={() => onSave({ type: "refresh-directory" })}
          >
            Refresh ST / QB dropdowns
          </button>
          <button
            disabled={busy}
            onClick={() => setNewRows((r) => [...r, (r.at(-1) || 0) + 1])}
          >
            Add assignment period
          </button>
          <a className="button-link" href="/api/card-mappings/export">
            Export mappings
          </a>
        </div>
      </div>
      <p className="muted">
        Select the QuickBooks card subaccount and the actual ServiceTitan card
        user. Save each changed row. End an earlier assignment before
        reassigning the card; historical periods remain visible.
      </p>
      {!state.directory && (
        <p className="notice">
          Refresh dropdowns to load ServiceTitan people and QuickBooks
          subaccounts. Existing spreadsheet mappings remain editable.
        </p>
      )}
      {state.directory && (
        <p className="muted">
          {state.mode === "demo" ? "Sample directories" : "Source directories"}{" "}
          · {state.directory.people.length} people ·{" "}
          {state.directory.accounts.length} card subaccounts · refreshed{" "}
          {new Date(state.directory.syncedAt).toLocaleString()}
        </p>
      )}
      <div className="mapping-grid table-scroll">
        <table>
          <thead>
            <tr>
              <th>QUICKBOOKS SUBACCOUNT</th>
              <th>SERVICETITAN PERSON</th>
              <th>EFFECTIVE FROM</th>
              <th>EFFECTIVE THROUGH</th>
              <th>REASON</th>
              <th>STATUS / SAVE</th>
            </tr>
          </thead>
          <tbody>
            {[...mappings]
              .sort(
                (a, b) =>
                  a.accountId.localeCompare(b.accountId) ||
                  a.from.localeCompare(b.from),
              )
              .map((m) => (
                <MappingRow
                  key={m.id}
                  initial={m}
                  state={state}
                  busy={busy}
                  onSave={onSave}
                />
              ))}
            {unmapped.map((a) => (
              <MappingRow
                key={`unmapped:${a.id}`}
                initial={{ accountId: a.id }}
                state={state}
                busy={busy}
                onSave={onSave}
              />
            ))}
            {newRows.map((n) => (
              <MappingRow
                key={`new:${n}`}
                initial={{}}
                state={state}
                busy={busy}
                onSave={async (body) => {
                  const ok = await onSave(body);
                  if (ok) setNewRows((r) => r.filter((v) => v !== n));
                  return ok;
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
      {!accounts.length && (
        <p>
          No card subaccounts yet. Refresh the directories or upload a mapping
          spreadsheet.
        </p>
      )}
      <details className="upload-disclosure">
        <summary>Upload or update mappings from Excel / CSV</summary>
        <CardMappingUpload state={state} busy={busy} onImported={onImported} />
      </details>
    </section>
  );
}
