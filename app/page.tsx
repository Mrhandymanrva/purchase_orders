"use client";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeftRight,
  LayoutDashboard,
  SlidersHorizontal,
  Plug,
  History,
  Search,
  RefreshCw,
  ChevronRight,
  Check,
  ArrowUpRight,
  X,
  ShieldCheck,
  CreditCard,
  BarChart3,
} from "lucide-react";
import { money, type State, type Result } from "@/lib/domain";
import { seed } from "@/lib/seed";
import { reconcile, ENGINE_VERSION } from "@/lib/engine";
import {
  cardUsers,
  ownershipLabel,
  filterResults,
  needsReview,
} from "@/lib/report";
import CardMappings from "./card-mappings";
import TechnicianScorecard from "./scorecard";
import LegalLinks from "./legal-links";
import IntegrationStatus from "./integration-status";
import QuickBooksConnection from "./quickbooks-connection";
import ServiceTitanConnection from "./servicetitan-connection";
export default function Page() {
  const [individual, setIndividual] = useState("All individuals"),
    [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<State>(seed),
    [tab, setTab] = useState("Reconciliation"),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("All items"),
    [selected, setSelected] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [reason, setReason] = useState(""),
    [action, setAction] = useState("confirm"),
    [manual, setManual] = useState(""),
    [dateFrom, setDateFrom] = useState(""),
    [dateTo, setDateTo] = useState("");
  const results = useMemo(
    () =>
      reconcile(
        state.records,
        state.config,
        state.rules,
        state.mode === "demo"
          ? "2026-09-13"
          : new Date().toISOString().slice(0, 10),
        state.decisions,
        state.coverage,
      ),
    [state],
  );
  const active = results.find((r) => r.id === selected);
  const visible = filterResults(results, state, {
    individual,
    status: filter,
    query,
    from: dateFrom,
    to: dateTo,
  });
  const scopedRecords = state.records.filter(
    (r) =>
      r.source === "qbo" &&
      (individual === "All individuals" ||
        (r.cardUser || "Unassigned") === individual) &&
      (!dateFrom || r.date >= dateFrom) &&
      (!dateTo || r.date <= dateTo),
  );
  const scopedResults = filterResults(results, state, {
    individual,
    from: dateFrom,
    to: dateTo,
  });
  const reportUrl =
    "/api/report?" +
    new URLSearchParams({
      individual,
      status: filter,
      query,
      from: dateFrom,
      to: dateTo,
    }).toString();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("tab") === "Integrations") setTab("Integrations");
    const qboOutcome = params.get("quickbooks");
    if (qboOutcome) {
      setMessage(
        qboOutcome === "connected"
          ? "QuickBooks company connected. Load credit-card accounts to choose your cards."
          : qboOutcome === "denied"
            ? "QuickBooks authorization was canceled. You can connect again when ready."
            : "QuickBooks connection did not complete. Check that the Redirect URI is saved, use the original company if reconnecting, and try again.",
      );
      window.history.replaceState(null, "", "/?tab=Integrations");
    }
    fetch("/api/state")
      .then(async (r) => {
        if (!r.ok) throw Error("Could not load data");
        setState(await r.json());
        setLoaded(true);
      })
      .catch((e) => setMessage(e.message));
  }, []);
  async function mutate(body: object) {
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, revision: state.revision }),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error || "Request failed");
      setState(data);
      setMessage("Saved successfully");
      setReason("");
      return true;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }
  const review = scopedResults.filter((r) => needsReview(r.status));
  const outsideCardCoverage = results.filter(
    (r) => r.status === "Outside card coverage",
  ).length;
  if (!loaded)
    return (
      <main className="loading-page">
        <h1>Richmond reconciliation</h1>
        <p role="status">{message || "Loading your workspace…"}</p>
        <LegalLinks />
        {message && (
          <button onClick={() => window.location.reload()}>Retry</button>
        )}
      </main>
    );
  return (
    <div className="shell">
      <aside className="sidebar" inert={!!active}>
        <a className="brand" href="/">
          <span className="brand-icon">
            <ArrowLeftRight size={22} />
          </span>
          richmond<span className="brand-dot">.</span>
        </a>
        <div className="workspace">
          <div className="avatar">RH</div>
          <div>
            <strong>Richmond operations</strong>
            <small>Purchase control</small>
          </div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {[
            [LayoutDashboard, "Reconciliation"],
            [CreditCard, "Card assignments"],
            [BarChart3, "Technician scorecards"],
            [SlidersHorizontal, "Rules & scoring"],
            [Plug, "Integrations"],
            [History, "Audit log"],
          ].map(([Icon, label]) => (
            <button
              key={String(label)}
              className={tab === label ? "nav active" : "nav"}
              onClick={() => setTab(String(label))}
            >
              {typeof Icon !== "string" && <Icon size={19} />}
              <span>{String(label)}</span>
              {label === "Reconciliation" && <b>{review.length}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <ShieldCheck size={24} />
          <strong>Read-only by design</strong>
          <p>Your accounting records stay in ServiceTitan and QuickBooks.</p>
          <div className="profile">
            <div className="avatar">RO</div>
            <div>
              <strong>Reconciliation operator</strong>
              <small>Richmond branch</small>
            </div>
          </div>
        </div>
      </aside>
      <main inert={!!active}>
        <header>
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} /> <strong>{tab}</strong>
          </div>
          <span className="mode">
            {state.mode === "demo" ? "DEMO WORKSPACE" : "LIVE WORKSPACE"}
          </span>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">RICHMOND, VIRGINIA</div>
              <h1>
                {tab === "Reconciliation" ? "Purchase reconciliation" : tab}
              </h1>
              <p>
                {tab === "Reconciliation"
                  ? "Every card purchase. Every purchase order. Accountable to the right person."
                  : "Control how your purchases are reviewed and reconciled."}
              </p>
            </div>
            <div className="heading-actions">
              {tab === "Reconciliation" && (
                <a className="button-link" href={reportUrl}>
                  Export report ↗
                </a>
              )}
              <button
                className="primary"
                disabled={busy}
                onClick={() => mutate({ type: "sync" })}
              >
                <RefreshCw size={16} className={busy ? "spin" : ""} />
                {busy
                  ? "Working…"
                  : state.mode === "demo"
                    ? "Run reconciliation"
                    : "Sync & reconcile"}
              </button>
            </div>
          </div>
          {message && (
            <div role="status" className="notice">
              {message}
              <button
                aria-label="Dismiss notification"
                onClick={() => setMessage("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {tab === "Reconciliation" ? (
            <>
              <div className="kpis">
                <div>
                  <span>Card purchases</span>
                  <strong>
                    {money(scopedRecords.reduce((a, r) => a + r.amount, 0))}
                  </strong>
                  <small>
                    {scopedRecords.length} posted transactions · {individual}
                  </small>
                </div>
                <div>
                  <span>Reconciled</span>
                  <strong className="green">
                    {
                      scopedResults.filter((r) =>
                        ["Matched", "Confirmed", "No PO required"].includes(
                          r.status,
                        ),
                      ).length
                    }
                    <em> groups</em>
                  </strong>
                  <small>Matched or approved exceptions</small>
                </div>
                <div>
                  <span>Needs review</span>
                  <strong>
                    {review.length}
                    <em> items</em>
                  </strong>
                  <small>
                    <i className="amber-dot" />
                    Ready for your attention
                  </small>
                </div>
                <div>
                  <span>Unresolved variance</span>
                  <strong>
                    {money(
                      review.reduce((a, r) => a + Math.abs(r.difference), 0),
                    )}
                  </strong>
                  <small>Full-group difference for these review items</small>
                </div>
              </div>
              <div className="connection-bar">
                <div>
                  <span className="integration-logo st">ST</span> ServiceTitan{" "}
                  <span className="link-line">↔</span>
                  <span className="integration-logo qb">qb</span> QuickBooks
                  Online
                </div>
                <span>
                  {state.lastSync
                    ? `Last run ${new Date(state.lastSync).toLocaleString()}`
                    : state.mode === "demo"
                      ? "Seeded sample · September 2026"
                      : "No successful sync yet"}
                </span>
              </div>
              {state.coverage && (
                <section
                  className="coverage-summary"
                  aria-label="Imported history"
                >
                  <strong>Imported history</strong>
                  <p>
                    QuickBooks:{" "}
                    {state.records.filter((r) => r.source === "qbo").length}{" "}
                    card purchases · {state.coverage.chargesFrom} through{" "}
                    {state.coverage.through}
                    <br />
                    ServiceTitan:{" "}
                    {state.records.filter((r) => r.source === "st").length} POs
                    · {state.coverage.posFrom} through {state.coverage.through}
                  </p>
                  {outsideCardCoverage > 0 && (
                    <p>
                      {outsideCardCoverage} unmatched POs fall outside the
                      imported card dates. They remain available for matching
                      and reporting, and are excluded from Needs review and
                      unresolved variance.{" "}
                      <button
                        onClick={() => {
                          setFilter("Outside card coverage");
                          setIndividual("All individuals");
                          setDateFrom("");
                          setDateTo("");
                          setQuery("");
                        }}
                      >
                        View these POs
                      </button>
                    </p>
                  )}
                </section>
              )}
              <section className="table-card">
                <div className="table-top">
                  <div className="tabs">
                    {["All items", "Needs review", "Matched", "Missing PO"].map(
                      (s) => (
                        <button
                          className={filter === s ? "selected" : ""}
                          onClick={() => setFilter(s)}
                          key={s}
                        >
                          {s}
                          {s === "All items" && <span>{results.length}</span>}
                        </button>
                      ),
                    )}
                  </div>
                  <div className="search">
                    <Search size={16} />
                    <input
                      aria-label="Search reconciliation"
                      placeholder="Search vendor or reference…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                </div>
                <div className="filters">
                  <SlidersHorizontal size={16} />
                  <select
                    aria-label="Card user filter"
                    value={individual}
                    onChange={(e) => setIndividual(e.target.value)}
                  >
                    {[
                      "All individuals",
                      ...Array.from(
                        new Set(
                          state.records
                            .filter((r) => r.source === "qbo")
                            .map((r) => r.cardUser || "Unassigned"),
                        ),
                      ).sort(),
                    ].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  <select
                    aria-label="Status filter"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    {Array.from(
                      new Set([
                        "All items",
                        "Needs review",
                        ...results.map((r) => r.status),
                      ]),
                    ).map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  <label>
                    From{" "}
                    <input
                      aria-label="From date"
                      type="date"
                      value={dateFrom}
                      onChange={(e) => setDateFrom(e.target.value)}
                    />
                  </label>
                  <label>
                    To{" "}
                    <input
                      aria-label="To date"
                      type="date"
                      value={dateTo}
                      onChange={(e) => setDateTo(e.target.value)}
                    />
                  </label>
                  <span>{visible.length} results</span>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>VENDOR / TRANSACTION</th>
                        <th>CARD USER</th>
                        <th>DATE</th>
                        <th>AMOUNT</th>
                        <th>STATUS</th>
                        <th>CONFIDENCE</th>
                        <th>PURCHASE ORDER</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((r) => (
                        <tr
                          key={r.id}
                          className={r.id === selected ? "row-selected" : ""}
                        >
                          <td>
                            <button
                              className="vendor-button"
                              onClick={() => {
                                setSelected(r.id);
                                setReason("");
                                setManual("");
                              }}
                            >
                              <span className="vendor-avatar">
                                {r.vendor.slice(0, 2).toUpperCase()}
                              </span>
                              <span>
                                <strong>{r.vendor}</strong>
                                <small>
                                  {r.charges.join(", ") ||
                                    "ServiceTitan purchase order"}{" "}
                                  · {r.kind}
                                </small>
                              </span>
                            </button>
                          </td>
                          <td className="card-user">
                            {ownershipLabel(state, r)}
                          </td>
                          <td>
                            {new Date(r.date + "T12:00:00").toLocaleDateString(
                              "en-US",
                              { month: "short", day: "numeric" },
                            )}
                          </td>
                          <td className="amount">
                            {money(
                              individual === "All individuals" ||
                                !r.charges.length
                                ? r.amount
                                : state.records
                                    .filter(
                                      (q) =>
                                        r.charges.includes(q.id) &&
                                        (q.cardUser || "Unassigned") ===
                                          individual,
                                    )
                                    .reduce((n, q) => n + q.amount, 0),
                            )}
                          </td>
                          <td>
                            <span className={"badge " + statusClass(r.status)}>
                              {r.status === "Matched" && <Check size={12} />}{" "}
                              {r.status}
                            </span>
                            {r.flags.includes("Late PO") &&
                              r.status !== "Late PO" && (
                                <small className="late">Late PO</small>
                              )}
                          </td>
                          <td>
                            {r.score > 0 ? (
                              <div className="confidence">
                                <span>{r.score}%</span>
                                <div>
                                  <i style={{ width: r.score + "%" }} />
                                </div>
                              </div>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td className="po">{r.pos.join(", ") || "—"}</td>
                          <td>
                            <button
                              className="icon-button"
                              aria-label={"Review " + r.vendor}
                              onClick={() => {
                                setSelected(r.id);
                                setReason("");
                                setManual("");
                              }}
                            >
                              <ArrowUpRight size={17} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {visible.length === 0 && (
                    <div className="empty">No items match these filters.</div>
                  )}
                </div>
                <footer>
                  <span>Amounts in USD · Credit balances are negative</span>
                  <span>Deterministic engine v{ENGINE_VERSION}</span>
                </footer>
              </section>
              <div className="bottom-note">
                <ShieldCheck size={16} /> Every match includes its evidence.
                Every decision leaves a trail.
              </div>
            </>
          ) : null}
          {tab === "Rules & scoring" && (
            <div className="settings-grid">
              <section className="panel">
                <h2>Matching policy</h2>
                <p>Changes apply on the next run. Weights must total 100.</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    mutate({
                      type: "config",
                      config: {
                        ...state.config,
                        ...Object.fromEntries(
                          [
                            "windowDays",
                            "graceDays",
                            "lateDays",
                            "toleranceCents",
                            "autoThreshold",
                            "ambiguityMargin",
                            "maxGroup",
                          ].map((k) => [k, Number(f.get(k))]),
                        ),
                        weights: Object.fromEntries(
                          ["vendor", "amount", "date", "reference"].map((k) => [
                            k,
                            Number(f.get(k)),
                          ]),
                        ),
                      },
                    });
                  }}
                  key={state.revision}
                >
                  {Object.entries(state.config)
                    .filter(([k]) => k !== "weights")
                    .map(([k, v]) => (
                      <label className="field" key={k}>
                        {
                          (
                            {
                              windowDays: "Match window (days)",
                              graceDays: "Missing item grace (days)",
                              lateDays: "Late PO threshold (days)",
                              toleranceCents: "Amount tolerance (cents)",
                              autoThreshold: "Automatic match threshold (%)",
                              ambiguityMargin: "Ambiguity margin (points)",
                              maxGroup: "Maximum group size",
                            } as Record<string, string>
                          )[k]
                        }
                        <input
                          name={k}
                          type="number"
                          defaultValue={Number(v)}
                          required
                        />
                      </label>
                    ))}
                  <h3>Confidence weights</h3>
                  {Object.entries(state.config.weights).map(([k, v]) => (
                    <label className="field" key={k}>
                      {k}
                      <input
                        name={k}
                        type="number"
                        defaultValue={v}
                        min="0"
                        max="100"
                        required
                      />
                    </label>
                  ))}
                  <button className="primary" disabled={busy}>
                    Save policy
                  </button>
                </form>
              </section>
              <section className="panel">
                <h2>Rules & suggestions</h2>
                <p>
                  Suggested rules never affect matching until explicitly
                  approved.
                </p>
                {state.rules.map((r) => (
                  <div className="rule" key={r.id}>
                    <span
                      className={
                        "badge " + (r.approved ? "success" : "warning")
                      }
                    >
                      {r.approved ? "Approved" : "Awaiting approval"}
                    </span>
                    <h3>
                      {r.type === "alias"
                        ? "Vendor normalization"
                        : "No PO required"}{" "}
                      · {r.pattern}
                    </h3>
                    <p>{r.description}</p>
                    {r.type === "no-po" && (
                      <small>
                        {r.maxCents === null
                          ? "No amount limit"
                          : `Limit ${money(r.maxCents)}`}
                      </small>
                    )}
                    {!r.approved && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          mutate({ type: "approve-rule", id: r.id })
                        }
                      >
                        Approve rule
                      </button>
                    )}
                  </div>
                ))}
                <h3>Propose a rule</h3>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    mutate({
                      type: "suggest-rule",
                      rule: {
                        type: f.get("type"),
                        pattern: f.get("pattern"),
                        target: f.get("target"),
                        maxCents:
                          f.get("type") === "no-po" && f.get("noLimit") === "on"
                            ? null
                            : Math.round(Number(f.get("limit")) * 100),
                        description: f.get("description"),
                      },
                    });
                  }}
                >
                  <label className="field">
                    Type
                    <select name="type">
                      <option value="alias">Vendor alias</option>
                      <option value="no-po">No PO required</option>
                    </select>
                  </label>
                  <label className="field">
                    Exact vendor
                    <input name="pattern" required />
                  </label>
                  <label className="field">
                    Canonical vendor (alias)
                    <input name="target" />
                  </label>
                  <label className="field">
                    Maximum amount ($)
                    <input
                      name="limit"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue="0"
                    />
                  </label>
                  <label className="field">
                    Reason
                    <input name="description" required minLength={5} />
                  </label>
                  <label>
                    <input type="checkbox" name="noLimit" /> No amount limit (No
                    PO required rules only)
                  </label>
                  <p className="muted">
                    Merchant exemptions include all purchases at that vendor.
                    Possible duplicates and refunds remain in review.
                  </p>
                  <button disabled={busy}>Submit for approval</button>
                </form>
              </section>
            </div>
          )}
          <CardMappings
            hidden={tab !== "Card assignments"}
            state={state}
            busy={busy}
            onSave={mutate}
            onImported={setState}
          />
          {tab === "Technician scorecards" && (
            <TechnicianScorecard
              state={state}
              results={results}
              busy={busy}
              onSave={mutate}
            />
          )}
          {tab === "Integrations" && (
            <div className="settings-grid">
              <QuickBooksConnection state={state} onChanged={setState} />
              <ServiceTitanConnection state={state} onChanged={setState} />
              <IntegrationStatus revision={state.revision} />
              <section className="panel account-mappings">
                <h2>People, cards and scorecards</h2>
                <p>
                  Manage the full editable assignment grid and refresh your
                  ServiceTitan / QuickBooks dropdowns.
                </p>
                <button onClick={() => setTab("Card assignments")}>
                  Open card assignments
                </button>{" "}
                <button onClick={() => setTab("Technician scorecards")}>
                  Open technician scorecards
                </button>
              </section>
              <section className="panel account-mappings">
                <h2>Read-only access</h2>
                <p>
                  ServiceTitan supplies purchase orders, vendors and source
                  directories. QuickBooks supplies posted Accounting API
                  credit-card purchases and credits; pending bank-feed items are
                  outside this API.
                </p>
                <p>
                  Resource requests use GET only. Credentials stay on the
                  server. A failed sync preserves the last imported snapshot.
                </p>
              </section>
            </div>
          )}
          {tab === "Audit log" && (
            <section className="panel">
              <h2>Decision history</h2>
              <p>
                Append-only events with a SHA-256 hash chain. All times are
                shown in your local timezone.
              </p>
              {state.audit.length === 0 ? (
                <div className="empty">
                  No decisions yet. Review an item or update a policy to begin.
                </div>
              ) : (
                state.audit
                  .slice()
                  .reverse()
                  .map((a) => (
                    <div className="audit" key={a.id}>
                      <History size={18} />
                      <div>
                        <strong>{a.action}</strong>
                        <small>
                          {new Date(a.at).toLocaleString()} · {a.actor}
                        </small>
                        <pre>{JSON.stringify(a.detail, null, 2)}</pre>
                        <code>{a.hash.slice(0, 24)}…</code>
                      </div>
                    </div>
                  ))
              )}
            </section>
          )}
        </div>
        <div className="app-legal-footer">
          <LegalLinks />
        </div>
      </main>
      {active && (
        <>
          <div className="backdrop" onClick={() => setSelected(null)} />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Reconciliation detail"
            className="detail"
            onKeyDown={(e) => {
              if (e.key === "Escape") setSelected(null);
              if (e.key === "Tab") {
                const elements = Array.from(
                  e.currentTarget.querySelectorAll<HTMLElement>(
                    "button:not(:disabled), input, select, textarea, a[href]",
                  ),
                );
                const first = elements[0],
                  last = elements.at(-1);
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <div className="detail-top">
              <span>RECONCILIATION DETAIL</span>
              <button
                autoFocus
                aria-label="Close detail"
                onClick={() => setSelected(null)}
              >
                <X size={20} />
              </button>
            </div>
            <h2>{active.vendor}</h2>
            <div className="detail-amount">{money(active.amount)}</div>
            <span className={"badge " + statusClass(active.status)}>
              {active.status}
            </span>
            <section>
              <h3>
                Match evidence <span>{active.score}%</span>
              </h3>
              {active.reasons.map((r, i) => (
                <p className="evidence" key={i}>
                  <ShieldCheck size={16} />
                  {r}
                </p>
              ))}
              {active.flags.map((f) => (
                <p className="notice" key={f}>
                  {f}
                </p>
              ))}
              <p>
                Difference <strong>{money(active.difference)}</strong>
              </p>
            </section>
            <section>
              <h3>Card user → purchase order</h3>
              <p>
                <strong>{ownershipLabel(state, active)}</strong>
              </p>
              <p>{active.pos.join(", ") || "No linked purchase order"}</p>
              <small>
                {["Matched", "Confirmed"].includes(active.status)
                  ? "Reconciled link"
                  : "Proposed link; review required before confirmation."}
              </small>
            </section>
            <section>
              <h3>Source records</h3>
              {[...active.charges, ...active.pos].map((id) => {
                const r = state.records.find((x) => x.id === id)!;
                return (
                  <div className="source-record" key={id}>
                    <span className="eyebrow">
                      {r.source === "qbo" ? "QUICKBOOKS" : "SERVICETITAN"}
                    </span>
                    <strong>
                      {r.id} <span>{money(r.amount)}</span>
                    </strong>
                    <small>
                      {r.date} · {r.account}
                    </small>
                    {r.source === "st" && r.poStatus && (
                      <small>ServiceTitan PO status: {r.poStatus}</small>
                    )}
                    <p>{r.description}</p>
                    {r.source === "qbo" && (
                      <>
                        <small>
                          Card user: {r.cardUser || "Unassigned"} ·{" "}
                          {r.ownershipSource || "Unassigned"}
                        </small>
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            const f = new FormData(e.currentTarget);
                            mutate({
                              type: "assign-card-user",
                              chargeId: r.id,
                              cardUser: f.get("cardUser"),
                              reason: f.get("ownershipReason"),
                            });
                          }}
                        >
                          <label className="field">
                            Actual card user
                            <input
                              name="cardUser"
                              defaultValue={
                                r.cardUser === "Unassigned" ? "" : r.cardUser
                              }
                              required
                              minLength={2}
                            />
                          </label>
                          <label className="field">
                            Assignment evidence
                            <input
                              name="ownershipReason"
                              placeholder="Card statement or receipt verified…"
                              required
                              minLength={5}
                            />
                          </label>
                          <button disabled={busy}>Save card user</button>
                        </form>
                      </>
                    )}
                  </div>
                );
              })}
            </section>
            <section>
              <h3>Manual review</h3>
              <label className="field">
                Decision
                <select
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                >
                  <option value="confirm">Confirm reconciliation</option>
                  <option value="dismiss">Dismiss exception</option>
                </select>
              </label>
              {active.charges.length > 0 && (
                <label className="field">
                  Override PO IDs (comma separated, optional)
                  <input
                    value={manual}
                    onChange={(e) => setManual(e.target.value)}
                    placeholder="PO-2041, PO-2042"
                  />
                </label>
              )}
              <label className="field">
                Reason (required)
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Explain the evidence supporting this decision…"
                  rows={3}
                />
              </label>
              <button
                className="primary"
                disabled={busy || reason.trim().length < 5}
                onClick={() =>
                  mutate({
                    type: "decision",
                    resultId: active.id,
                    action,
                    reason,
                    poIds: manual.trim()
                      ? manual.split(",").map((s) => s.trim())
                      : undefined,
                  })
                }
              >
                Save review decision
              </button>
              <p className="muted">
                This updates the reconciliation record only.
              </p>
            </section>
          </aside>
        </>
      )}
    </div>
  );
}
function statusClass(s: string) {
  return ["Matched", "Confirmed", "No PO required"].includes(s)
    ? "success"
    : [
          "Missing vendor",
          "Missing PO",
          "Amount mismatch",
          "Possible duplicate",
        ].includes(s)
      ? "warning"
      : "neutral";
}
