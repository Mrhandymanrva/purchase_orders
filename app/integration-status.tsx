"use client";
import { useEffect, useState } from "react";
import type { IntegrationSetup } from "@/lib/integration-setup";

export default function IntegrationStatus({
  revision = 0,
}: {
  revision?: number;
}) {
  const [setup, setSetup] = useState<IntegrationSetup | null>(null);
  const [demo, setDemo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/integrations/status", {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Could not check settings");
      setDemo(data.demo);
      setSetup(data.setup || null);
    } catch (e) {
      setSetup(null);
      setError(e instanceof Error ? e.message : "Could not check settings");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [revision]);
  return (
    <>
      <section className="panel account-mappings">
        <h2>Connection setup</h2>
        <p>
          Check which settings are present before loading people, card accounts
          and purchases.
        </p>
        <button onClick={refresh} disabled={busy}>
          {busy ? "Checking settings…" : "Recheck setup"}
        </button>
        <div role="status">
          {error && <p>{error}</p>}
          {demo && (
            <p>Sample workspace. Production connections are not used.</p>
          )}
          {setup && (
            <p>
              {setup.syncReady
                ? "Required settings are present. Run Sync & reconcile to verify access and import records."
                : setup.directoryReady
                  ? "Dropdown settings are present. Complete the import settings before syncing purchases."
                  : "Setup is incomplete. Complete the missing settings below to load the source dropdowns."}
            </p>
          )}
        </div>
        {!demo && (
          <p>
            Enter production credentials in Railway → purchase_orders →
            Variables, then deploy the changes. Use Connect QuickBooks above to
            authorize your company and select its card accounts. The company ID,
            authorization token and selected card IDs are saved automatically.
            Settings marked present have not necessarily been accepted by the
            source API.
          </p>
        )}
      </section>
      {setup?.sources.map((source) => (
        <section className="panel" key={source.name}>
          <h2>{source.name}</h2>
          <span className="badge neutral">{source.environment}</span>
          <ul className="setup-checks">
            {source.checks.map((check) => (
              <li key={check.setting}>
                <div>
                  <strong>{check.label}</strong>
                  {[
                    "QBO_REALM_ID",
                    "QBO_REFRESH_TOKEN",
                    "QBO_CARD_ACCOUNT_IDS",
                    "QBO_PARENT_CC_ACCOUNT_ID or QBO_CARD_ACCOUNT_IDS",
                  ].includes(check.setting) ? (
                    <small>
                      Managed by Connect QuickBooks and card selection above
                    </small>
                  ) : (
                    <code>{check.setting}</code>
                  )}
                  {check.syncOnly && <small>Needed for purchase sync</small>}
                </div>
                <span
                  className={
                    check.configured ? "setup-present" : "setup-missing"
                  }
                >
                  {check.configured ? "Present" : "Missing / invalid"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
