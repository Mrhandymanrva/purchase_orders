"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { State } from "@/lib/domain";
import { cardDescendants } from "@/lib/quickbooks-accounts";

export default function QuickBooksConnection({
  state,
  onChanged,
}: {
  state: State;
  onChanged: (state: State) => void;
}) {
  const qbo = state.quickbooks;
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [parent, setParent] = useState(qbo?.parentAccountId || ""),
    [selected, setSelected] = useState<string[]>(qbo?.accountIds || []),
    [reason, setReason] = useState("");
  const [redirect, setRedirect] = useState("");
  const [saveAttempted, setSaveAttempted] = useState(false);
  const reasonInput = useRef<HTMLInputElement>(null);
  const reasonError = saveAttempted && reason.trim().length < 5;
  const cardsError = saveAttempted && selected.length === 0;
  useEffect(() => {
    setRedirect(
      window.location.origin + "/api/integrations/quickbooks/callback",
    );
  }, []);
  useEffect(() => {
    setParent(qbo?.parentAccountId || "");
    setSelected(qbo?.accountIds || []);
  }, [state.revision]);
  const cards = cardDescendants(qbo?.accounts || [], parent);
  const parents = (qbo?.accounts || []).filter(
    (a) => a.active && cardDescendants(qbo?.accounts || [], a.id).length > 0,
  );
  function saveSelection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setSaveAttempted(true);
    setMessage("");
    if (reason.trim().length < 5) reasonInput.current?.focus();
    if (!selected.length || reason.trim().length < 5) return;
    void accounts("save");
  }
  async function connect() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/integrations/quickbooks/connect", {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Could not start connection");
      const url = new URL(data.url);
      if (url.protocol !== "https:" || url.hostname !== "appcenter.intuit.com")
        throw Error("Unexpected connection address");
      window.location.assign(url.toString());
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not start connection");
      setBusy(false);
    }
  }
  async function accounts(action: "discover" | "save") {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/integrations/quickbooks/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          revision: state.revision,
          ...(action === "save"
            ? {
                parentAccountId: parent,
                accountIds: selected,
                reason: reason.trim(),
              }
            : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw Error(data.error || "Could not update card selection");
      onChanged(data);
      setSaveAttempted(false);
      setReason("");
      setMessage(
        action === "discover"
          ? "Card accounts loaded. Choose the main account and the individual cards below."
          : "Card selection saved. It will apply on the next successful sync; existing reports keep the previous snapshot until then.",
      );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Could not update card selection",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel account-mappings qbo-onboarding">
      <h2>Connect QuickBooks</h2>
      <p>
        Sign in to Intuit and choose your Richmond company. The app receives the
        company ID and stores the authorization securely.
      </p>
      {qbo && (
        <p>
          <strong>{qbo.companyName}</strong> ·{" "}
          {qbo.environment === "production" ? "Production" : "Sandbox"} ·
          Company authorized {new Date(qbo.connectedAt).toLocaleDateString()}
        </p>
      )}
      <button onClick={connect} disabled={busy || state.mode === "demo"}>
        {qbo ? "Reconnect QuickBooks" : "Connect QuickBooks"}
      </button>
      {qbo && (
        <button onClick={() => accounts("discover")} disabled={busy}>
          Load credit-card accounts
        </button>
      )}
      {state.mode === "demo" && (
        <p>
          Connect from the deployed workspace to use your real QuickBooks
          company.
        </p>
      )}
      {!qbo?.discoveredAt && <p role="status">{busy ? "Working…" : message}</p>}
      <details>
        <summary>One-time Intuit app setup</summary>
        <p>
          In your Intuit Developer app, open Production Settings → Keys & OAuth
          (or Keys & credentials) → Redirect URIs → Add URI. Paste this address
          and Save:
        </p>
        <code className="callback-address">{redirect}</code>
        <p>
          The production Client ID and Client Secret stay in Railway. Company
          authorization and card selection are handled here.
        </p>
      </details>
      {qbo?.discoveredAt && (
        <form className="qbo-card-picker" onSubmit={saveSelection} noValidate>
          <h3>Choose purchases to import</h3>
          <label className="field">
            Main credit-card account
            <select
              aria-label="QuickBooks parent credit-card account"
              value={parent}
              disabled={busy}
              onChange={(e) => {
                setParent(e.target.value);
                setSelected([]);
                setSaveAttempted(false);
              }}
            >
              <option value="">Choose an account</option>
              {parents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          {!parents.length && (
            <p>
              No parent credit-card accounts with individual card subaccounts
              were found in this company.
            </p>
          )}
          {parent && (
            <>
              <div className="qbo-picker-heading">
                <strong>{selected.length} cards selected</strong>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setSelected(cards.filter((a) => a.active).map((a) => a.id))
                  }
                >
                  Select all active cards
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setSelected([])}
                >
                  Clear selection
                </button>
              </div>
              <div className="qbo-card-list">
                {cards.map((a) => (
                  <label key={a.id}>
                    <input
                      type="checkbox"
                      disabled={busy || !a.active}
                      checked={selected.includes(a.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, a.id]
                            : selected.filter((id) => id !== a.id),
                        )
                      }
                    />
                    <span>
                      {a.name}
                      {!a.active ? " (inactive)" : ""}
                      <small>Account ID {a.id}</small>
                    </span>
                  </label>
                ))}
              </div>
              {cardsError && (
                <p className="field-error" role="alert">
                  Select at least one active card to save this selection.
                </p>
              )}
              <label className="field">
                Reason for this selection (required)
                <input
                  ref={reasonInput}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Initial Richmond card setup"
                  required
                  minLength={5}
                  maxLength={500}
                  disabled={busy}
                  aria-invalid={reasonError || undefined}
                  aria-describedby={
                    reasonError
                      ? "qbo-reason-help qbo-reason-error"
                      : "qbo-reason-help"
                  }
                />
              </label>
              <p id="qbo-reason-help">
                Enter at least 5 characters explaining this selection. Your
                reason is saved in the audit log.
              </p>
              {reasonError && (
                <p id="qbo-reason-error" className="field-error" role="alert">
                  Enter a reason of at least 5 characters, such as “Initial
                  Richmond card setup”.
                </p>
              )}
              <button type="submit" disabled={busy}>
                {busy ? "Working…" : "Save card selection"}
              </button>
              <p>
                Only checked child accounts are imported. New cards must be
                selected before a later sync includes them. Parent statement
                balances are excluded.
              </p>
            </>
          )}
          <p role="status">{busy ? "Working…" : message}</p>
        </form>
      )}
    </section>
  );
}
