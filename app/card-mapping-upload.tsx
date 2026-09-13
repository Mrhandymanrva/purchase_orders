"use client";
import { useState } from "react";
import type { State } from "@/lib/domain";
import type { ImportPlan } from "@/lib/card-import";
type Preview = Pick<ImportPlan, "errors" | "counts" | "changes"> & {
  token: string | null;
  revision: number;
  filename: string;
};
export default function CardMappingUpload({
  state,
  onImported,
  busy,
}: {
  state: State;
  onImported: (s: State) => void;
  busy: boolean;
}) {
  const [file, setFile] = useState<File | null>(null),
    [reason, setReason] = useState("Cardholder roster update"),
    [preview, setPreview] = useState<Preview | null>(null),
    [working, setWorking] = useState(false),
    [message, setMessage] = useState("");
  const stale = preview && preview.revision !== state.revision;
  async function review() {
    if (!file) return;
    setWorking(true);
    setMessage("");
    setPreview(null);
    try {
      if (file.size > 2 * 1024 * 1024)
        throw Error("File must be 2 MB or smaller.");
      const res = await fetch(
        "/api/card-mappings/import?" +
          new URLSearchParams({ filename: file.name, reason }),
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        },
      );
      const data = await res.json();
      if (!res.ok) throw Error(data.error || "Could not read file");
      setPreview(data);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setWorking(false);
    }
  }
  async function apply() {
    if (!preview?.token) return;
    setWorking(true);
    setMessage("");
    try {
      const res = await fetch("/api/card-mappings/import", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: preview.token }),
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error || "Import failed");
      onImported(data);
      setMessage(
        `Import saved: ${preview.counts.new} new, ${preview.counts.updated} updated, ${preview.counts.unchanged} unchanged, ${preview.counts.closed} earlier assignments ended.`,
      );
      setPreview(null);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Import failed");
    } finally {
      setWorking(false);
    }
  }
  return (
    <div className="mapping-upload">
      <div className="upload-heading">
        <div>
          <h3>Upload a cardholder spreadsheet</h3>
          <p>
            Import up to 1,000 rows from Excel (.xlsx) or CSV. Preview changes,
            then apply the complete update.
          </p>
        </div>
        <div className="upload-links">
          <a
            href="/templates/card-mappings-template.xlsx"
            className="button-link"
            download
          >
            Download Excel template
          </a>
          <a href="/api/card-mappings/export" className="button-link">
            Export current mappings
          </a>
        </div>
      </div>
      <div className="upload-controls">
        <label className="field">
          Mapping spreadsheet
          <input
            aria-label="Mapping spreadsheet"
            type="file"
            accept=".xlsx,.csv"
            disabled={busy || working}
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              setPreview(null);
              setMessage("");
            }}
          />
        </label>
        <label className="field">
          Import reason
          <input
            value={reason}
            minLength={5}
            maxLength={500}
            onChange={(e) => {
              setReason(e.target.value);
              setPreview(null);
            }}
            disabled={working}
          />
        </label>
        <button
          className="primary"
          disabled={!file || busy || working || reason.trim().length < 5}
          onClick={review}
        >
          {working ? "Working…" : "Preview spreadsheet"}
        </button>
      </div>
      <p className="muted">
        Reuploads update existing assignments. Omitted cards stay mapped. A
        later start date creates a new assignment and ends the previous open
        period. For precise edits, export the current mappings and retain their
        Mapping IDs.
      </p>
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {preview && (
        <div className="import-preview">
          <h3>{preview.filename}</h3>
          <div className="import-counts">
            <span>
              <strong>{preview.counts.new}</strong> new
            </span>
            <span>
              <strong>{preview.counts.updated}</strong> updated
            </span>
            <span>
              <strong>{preview.counts.unchanged}</strong> unchanged
            </span>
            <span>
              <strong>{preview.counts.closed}</strong> earlier assignments ended
            </span>
          </div>
          {preview.errors.length > 0 && (
            <div role="alert" className="notice">
              <div>
                <strong>
                  Nothing will be imported until these rows are corrected.
                </strong>
                <ul>
                  {preview.errors.map((e, i) => (
                    <li key={i}>
                      {e.row ? `Row ${e.row}: ` : ""}
                      {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <div className="table-scroll import-table">
            <table>
              <thead>
                <tr>
                  <th>ROW</th>
                  <th>CHANGE</th>
                  <th>SUBACCOUNT</th>
                  <th>PREVIOUS ASSIGNMENT</th>
                  <th>NEW ASSIGNMENT</th>
                </tr>
              </thead>
              <tbody>
                {preview.changes.map((c, i) => (
                  <tr key={i}>
                    <td>{c.row || "Existing"}</td>
                    <td>
                      <span
                        className={
                          "badge " +
                          (c.kind === "unchanged" ? "neutral" : "warning")
                        }
                      >
                        {c.kind}
                      </span>
                    </td>
                    <td>
                      {c.after.accountName || c.after.accountId}
                      <small className="block">{c.after.accountId}</small>
                    </td>
                    <td>
                      {c.before ? (
                        <>
                          {c.before.cardUser}
                          <small className="block">
                            {c.before.accountName || c.before.accountId}
                          </small>
                          <small className="block">
                            {c.before.from} – {c.before.through || "ongoing"}
                          </small>
                          <small className="block">
                            Reason: {c.before.reason}
                          </small>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {c.after.cardUser}
                      <small className="block">
                        {c.after.accountName || c.after.accountId}
                      </small>
                      <small className="block">
                        {c.after.from} – {c.after.through || "ongoing"}
                      </small>
                      <small className="block">Reason: {c.after.reason}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {stale && (
            <p role="alert" className="notice">
              The workspace changed after this preview. Preview the spreadsheet
              again before applying.
            </p>
          )}
          <button
            className="primary"
            disabled={busy || working || !preview.token || !!stale}
            onClick={apply}
          >
            Apply reviewed import
          </button>
          <p className="muted">
            Updates are saved together with an audit record. Individual charge
            overrides stay in effect.
          </p>
        </div>
      )}
    </div>
  );
}
