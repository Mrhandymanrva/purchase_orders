"use client";
import { useEffect, useRef, useState } from "react";
import { type State, type CardMapping } from "@/lib/domain";
import { accountOptions } from "@/lib/directory";
import CardMappingUpload from "./card-mapping-upload";

type Save = (body: object) => Promise<boolean>;
type Draft = {
  accountId: string;
  person: string;
};
type Row = { key: string; initial: Partial<CardMapping> };
function initialDraft(initial: Partial<CardMapping>): Draft {
  return {
    accountId: initial.accountId || "",
    person:
      initial.personId || (initial.cardUser ? `name:${initial.cardUser}` : ""),
  };
}

function MappingRow({
  state,
  row,
  draft,
  dirty,
  busy,
  error,
  onUpdate,
  onSave,
}: {
  state: State;
  row: Row;
  draft: Draft;
  dirty: boolean;
  busy: boolean;
  error?: string;
  onUpdate: (field: keyof Draft, value: string) => void;
  onSave: () => void;
}) {
  const initial = row.initial;
  const people = state.directory?.people || [],
    accounts = accountOptions(state);
  const label = initial.id || initial.accountId || row.key;
  return (
    <tr className={dirty ? "mapping-dirty" : ""}>
      <td>
        <select
          aria-label={`QuickBooks account ${label}`}
          value={draft.accountId}
          disabled={busy}
          onChange={(e) => onUpdate("accountId", e.target.value)}
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
          onChange={(e) => onUpdate("person", e.target.value)}
        >
          <option value="">Select person</option>
          {draft.person.startsWith("name:") && (
            <option value={draft.person}>
              {draft.person.slice(5)} · imported name
            </option>
          )}
          {draft.person &&
            !draft.person.startsWith("name:") &&
            !people.some((p) => p.id === draft.person) && (
              <option value={draft.person}>
                {initial.cardUser} · historical assignment ({draft.person})
              </option>
            )}
          {people
            .filter((p) => p.active || p.id === draft.person)
            .sort(
              (a, b) =>
                a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
            )
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
      <td className="mapping-row-actions">
        <span
          className={
            "badge " + (dirty ? "warning" : initial.id ? "neutral" : "warning")
          }
        >
          {dirty ? "Unsaved" : initial.id ? "Saved" : "Unmapped"}
        </span>
        <button
          className="mapping-save"
          disabled={busy || !dirty}
          onClick={onSave}
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
  hidden = false,
}: {
  state: State;
  busy: boolean;
  onSave: Save;
  onImported: (s: State) => void;
  hidden?: boolean;
}) {
  const [drafts, setDrafts] = useState<
    Record<string, { draft: Draft; initial: Partial<CardMapping> }>
  >({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const accounts = accountOptions(state),
    mappings = state.cardMappings || [];
  const unmapped = accounts.filter(
    (a) => a.active && !mappings.some((m) => m.accountId === a.id),
  );
  const currentRows: Row[] = [
    ...[...mappings]
      .sort((a, b) => a.accountId.localeCompare(b.accountId))
      .map((m) => ({ key: m.id, initial: m })),
    ...unmapped.map((a) => ({
      key: `unmapped:${a.id}`,
      initial: { accountId: a.id },
    })),
  ];
  // Keep another row's draft even if saving a changed account removes its
  // original unmapped placeholder from the server-provided roster.
  const rows = [
    ...currentRows,
    ...Object.entries(drafts)
      .filter(([key]) => !currentRows.some((row) => row.key === key))
      .map(([key, value]) => ({ key, initial: value.initial })),
  ];
  const dirtyRows = rows.filter(
    (row) =>
      drafts[row.key] &&
      JSON.stringify(drafts[row.key].draft) !==
        JSON.stringify(initialDraft(row.initial)),
  );
  const dirtyKeys = new Set(dirtyRows.map((row) => row.key));
  const locked = busy || saving;
  useEffect(() => {
    if (!dirtyRows.length) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirtyRows.length]);

  function update(row: Row, field: keyof Draft, value: string) {
    setDrafts((current) => ({
      ...current,
      [row.key]: {
        initial: current[row.key]?.initial || row.initial,
        draft: {
          ...(current[row.key]?.draft || initialDraft(row.initial)),
          [field]: value,
        },
      },
    }));
    setErrors((current) => {
      const next = { ...current };
      delete next[row.key];
      return next;
    });
    setNotice("");
  }
  async function saveRows(selected: Row[], bulk: boolean) {
    if (locked || savingRef.current || !selected.length) return;
    const invalid: Record<string, string> = {};
    const payload = selected.map((row) => {
      const draft = drafts[row.key]?.draft || initialDraft(row.initial);
      const person = state.directory?.people.find((p) => p.id === draft.person);
      const historical =
        draft.person === row.initial.personId
          ? row.initial.cardUser
          : undefined;
      const cardUser =
        person?.name ||
        historical ||
        (draft.person.startsWith("name:") ? draft.person.slice(5) : "");
      if (!draft.accountId || !cardUser)
        invalid[row.key] = "Choose a subaccount and person.";
      return {
        id: row.initial.id,
        accountId: draft.accountId,
        cardUser,
        personId: person?.id || (historical ? row.initial.personId : undefined),
      };
    });
    if (Object.keys(invalid).length) {
      setErrors(invalid);
      setNotice(
        `Check ${Object.keys(invalid).length} highlighted row(s). Nothing was saved; your edits are still here.`,
      );
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setNotice("");
    try {
      const ok = await onSave(
        bulk
          ? { type: "save-card-mappings", mappings: payload }
          : { type: "save-card-mapping", mapping: payload[0] },
      );
      if (!ok) {
        setNotice(
          "Could not save. Your edits are still here; see the error above.",
        );
        return;
      }
      const saved = new Set(selected.map((row) => row.key));
      setDrafts((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => !saved.has(key)),
        ),
      );
      setErrors((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => !saved.has(key)),
        ),
      );
      setNotice(
        `${selected.length} assignment${selected.length === 1 ? "" : "s"} saved.`,
      );
    } catch {
      setNotice("Could not save. Your edits are still here. Try again.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  return (
    <section className="panel account-mappings" hidden={hidden}>
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
            disabled={locked}
            onClick={() => onSave({ type: "refresh-directory" })}
          >
            Refresh ST / QB dropdowns
          </button>
          <a className="button-link" href="/api/card-mappings/export">
            Export mappings
          </a>
        </div>
      </div>
      <p className="muted">
        Choose the employee for each card, then Save all changes. Each mapping
        covers that card's full purchase history. Closed cards keep their
        employee mapping for reporting. Use a new card for each new employee.
      </p>
      {!state.directory?.people.length && (
        <p className="notice">
          ServiceTitan people have not loaded. Click Refresh ST / QB dropdowns
          above to load the people list. Existing spreadsheet mappings remain
          editable.
        </p>
      )}
      {state.directory && (
        <p className="muted">
          {state.mode === "demo" ? "Sample directories" : "Source directories"}{" "}
          · {state.directory.people.filter((p) => p.active).length} active
          people · {state.directory.accounts.length} card subaccounts ·
          refreshed {new Date(state.directory.syncedAt).toLocaleString()}
        </p>
      )}
      <div className="mapping-save-bar">
        <div>
          <strong aria-live="polite">
            {dirtyRows.length
              ? `${dirtyRows.length} unsaved assignment${dirtyRows.length === 1 ? "" : "s"}`
              : "No unsaved changes"}
          </strong>
          {notice && (
            <small className="block" role="status">
              {notice}
            </small>
          )}
        </div>
        <button
          className="primary"
          disabled={locked || !dirtyRows.length}
          onClick={() => saveRows(dirtyRows, true)}
        >
          {saving ? "Saving…" : "Save all changes"}
        </button>
      </div>
      <div className="mapping-grid table-scroll">
        <table>
          <colgroup>
            <col style={{ width: "43%" }} />
            <col style={{ width: "39%" }} />
            <col style={{ width: "18%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>QUICKBOOKS SUBACCOUNT</th>
              <th>SERVICETITAN PERSON</th>
              <th className="mapping-row-actions">STATUS / SAVE</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <MappingRow
                key={row.key}
                row={row}
                state={state}
                draft={drafts[row.key]?.draft || initialDraft(row.initial)}
                dirty={dirtyKeys.has(row.key)}
                busy={locked}
                error={errors[row.key]}
                onUpdate={(field, value) => update(row, field, value)}
                onSave={() => saveRows([row], false)}
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
        {dirtyRows.length > 0 && (
          <p className="muted">
            Save your grid changes before uploading a spreadsheet.
          </p>
        )}
        <CardMappingUpload
          state={state}
          busy={locked || dirtyRows.length > 0}
          onImported={onImported}
        />
      </details>
    </section>
  );
}
