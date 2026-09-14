"use client";
import { useState } from "react";
import { money, type State, type Result } from "@/lib/domain";
import { isVanStockTypeName } from "@/lib/van-stock";
import {
  periodRange,
  periodContaining,
  scorecard,
  weeksInYear,
  type Period,
} from "@/lib/scorecard";
export default function TechnicianScorecard({
  state,
  results,
  busy,
  onSave,
}: {
  state: State;
  results: Result[];
  busy: boolean;
  onSave: (b: object) => Promise<boolean>;
}) {
  const today =
      state.mode === "demo"
        ? "2026-09-13"
        : new Date().toISOString().slice(0, 10),
    thisYear = Number(today.slice(0, 4));
  const [period, setPeriod] = useState<Period>({
      unit: "month",
      year: thisYear,
      period: Number(today.slice(5, 7)),
    }),
    [personId, setPersonId] = useState("all"),
    [showEvidence, setShowEvidence] = useState(false);
  const range = periodRange(period),
    data = scorecard(state, results, range),
    selected = data.rows.find((r) => r.id === personId),
    metric =
      personId === "all"
        ? data.total
        : selected || {
            ...data.total,
            spend: 0,
            chargeCount: 0,
            poTotal: 0,
            poCount: 0,
            vanStock: 0,
            vanStockCount: 0,
          };
  const count =
    period.unit === "week"
      ? weeksInYear(period.year)
      : period.unit === "month"
        ? 12
        : period.unit === "quarter"
          ? 4
          : 1;
  const years = Array.from(
    new Set([
      thisYear + 1,
      ...Array.from({ length: 6 }, (_, i) => thisYear - i),
      ...state.records.map((r) => Number(r.date.slice(0, 4))),
    ]),
  ).sort((a, b) => b - a);
  const label = (n: number) =>
    period.unit === "week"
      ? `Week ${n} · ${periodRange({ ...period, period: n }).from}`
      : period.unit === "month"
        ? new Date(Date.UTC(period.year, n - 1, 1)).toLocaleString("en-US", {
            month: "long",
            timeZone: "UTC",
          })
        : `Q${n}`;
  const partial =
    state.coverage &&
    (range.from < state.coverage.chargesFrom ||
      range.from < state.coverage.posFrom ||
      range.to > state.coverage.through);
  const exportUrl =
    "/api/scorecard?" +
    new URLSearchParams({
      unit: period.unit,
      year: String(period.year),
      period: String(period.period),
      person: personId,
    });
  return (
    <div className="technician-scorecard">
      <section className="panel period-panel">
        <div className="grid-heading">
          <div>
            <h2>Technician purchase scorecard</h2>
            <p>
              Card spend, purchase orders and Van Stock for the same reporting
              period.
            </p>
          </div>
          <div className="export-actions" aria-label="Export scorecard">
            <a className="button-link" href={exportUrl}>
              Export CSV
            </a>
            <a className="button-link" href={exportUrl + "&format=pdf"}>
              Export PDF
            </a>
          </div>
        </div>
        <div className="period-controls">
          <label className="field">
            View by
            <select
              aria-label="Scorecard period"
              value={period.unit}
              onChange={(e) => {
                const next = periodContaining(
                  today,
                  e.target.value as Period["unit"],
                );
                setPeriod({
                  ...next,
                  year: period.year,
                  period:
                    next.unit === "week"
                      ? Math.min(next.period, weeksInYear(period.year))
                      : next.period,
                });
              }}
            >
              {[
                ["week", "Week"],
                ["month", "Month"],
                ["quarter", "QTR"],
                ["year", "Year"],
              ].map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Year
            <select
              aria-label="Scorecard year"
              value={period.year}
              onChange={(e) =>
                setPeriod({
                  ...period,
                  year: Number(e.target.value),
                  period:
                    period.unit === "week"
                      ? Math.min(
                          period.period,
                          weeksInYear(Number(e.target.value)),
                        )
                      : period.period,
                })
              }
            >
              {years.map((y) => (
                <option key={y}>{y}</option>
              ))}
            </select>
          </label>
          {period.unit !== "year" && (
            <label className="field">
              {period.unit === "week"
                ? "Week"
                : period.unit === "month"
                  ? "Month"
                  : "Quarter"}
              <select
                aria-label="Scorecard interval"
                value={period.period}
                onChange={(e) =>
                  setPeriod({ ...period, period: Number(e.target.value) })
                }
              >
                {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {label(n)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            Technician / card user
            <select
              aria-label="Scorecard technician"
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
            >
              <option value="all">All people</option>
              {personId !== "all" && !selected && (
                <option value={personId}>{personId} · No activity</option>
              )}
              {data.rows.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.kind}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="period-range">
          {range.from} through {range.to} · Weeks run Monday–Sunday (ISO).
          Calendar months, quarters and years.
        </p>
        {state.mode === "demo" && (
          <p className="muted">
            Sample records cover September 2026. Other periods may have no
            sample activity.
          </p>
        )}
        {state.mode === "live" && (!state.coverage || partial) && (
          <p className="notice">
            {state.coverage
              ? `Partial period: card data imported from ${state.coverage.chargesFrom}, POs from ${state.coverage.posFrom}, through ${state.coverage.through}.`
              : "No completed live sync yet. These totals are not a complete reporting period."}
          </p>
        )}
      </section>
      <div className="kpis scorecard-kpis">
        <div>
          <span>Total card spend</span>
          <strong>{money(metric.spend)}</strong>
          <small>{metric.chargeCount} posted purchases / credits</small>
        </div>
        <div>
          <span>Total PO</span>
          <strong>{money(metric.poTotal)}</strong>
          <small>{metric.poCount} POs · including uncharged POs</small>
        </div>
        <div>
          <span>Spend / PO</span>
          <strong>
            {metric.poTotal > 0
              ? `${((metric.spend / metric.poTotal) * 100).toFixed(1)}%`
              : "—"}
          </strong>
          <small>Net card dollars ÷ net PO dollars</small>
        </div>
        <div>
          <span>Van Stock</span>
          <strong>
            {data.vanStockConfigured
              ? money(metric.vanStock)
              : "Not configured"}
          </strong>
          <small>
            {data.vanStockConfigured
              ? `${metric.vanStockCount} POs · included in Total PO`
              : "Select the ServiceTitan PO types below"}
          </small>
        </div>
      </div>
      <section className="panel">
        <h2>By technician</h2>
        <div className="table-scroll">
          <table className="scorecard-table">
            <thead>
              <tr>
                <th>TECHNICIAN / CARD USER</th>
                <th>TOTAL SPEND</th>
                <th>TOTAL PO</th>
                <th>SPEND / PO</th>
                <th>VAN STOCK</th>
                <th>VAN STOCK POs</th>
              </tr>
            </thead>
            <tbody>
              {data.rows
                .filter((r) => personId === "all" || r.id === personId)
                .map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button
                        className="person-link"
                        onClick={() => {
                          setPersonId(r.id);
                          setShowEvidence(true);
                        }}
                      >
                        {r.name}
                      </button>
                      <small className="block">
                        {r.kind} · {r.id}
                      </small>
                    </td>
                    <td>
                      {money(r.spend)}
                      <small className="block">
                        {r.chargeCount} transactions
                      </small>
                    </td>
                    <td>
                      {money(r.poTotal)}
                      <small className="block">{r.poCount} POs</small>
                    </td>
                    <td>
                      {r.poTotal > 0
                        ? `${((r.spend / r.poTotal) * 100).toFixed(1)}%`
                        : "—"}
                    </td>
                    <td>{data.vanStockConfigured ? money(r.vanStock) : "—"}</td>
                    <td>{data.vanStockConfigured ? r.vanStockCount : "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <p className="muted">
          Spend uses the card purchase date; POs use their own PO date. Credits
          reduce totals. Reconciled POs follow the actual card user; otherwise
          the ServiceTitan PO technician is used. POs spanning multiple card
          users are counted once under Shared card users. Proposed matches do
          not assign POs.
        </p>
        {data.total.unknownPoTypeCount > 0 && (
          <p className="notice">
            {data.total.unknownPoTypeCount} POs have no VAN STOCK / VS label and
            their source type is unavailable. Van Stock totals may be incomplete
            until those POs can be classified.
          </p>
        )}
        <button onClick={() => setShowEvidence(!showEvidence)}>
          {showEvidence ? "Hide" : "Show"} source details
        </button>
        {showEvidence && (
          <div className="table-scroll scorecard-evidence">
            <table>
              <thead>
                <tr>
                  <th>PERSON</th>
                  <th>SOURCE / REFERENCE</th>
                  <th>DATE</th>
                  <th>AMOUNT</th>
                  <th>VAN STOCK</th>
                  <th>ST LABEL / RULE</th>
                  <th>ATTRIBUTION</th>
                </tr>
              </thead>
              <tbody>
                {data.evidence
                  .filter((e) => personId === "all" || e.ownerId === personId)
                  .map((e) => (
                    <tr key={e.record.id}>
                      <td>{e.owner}</td>
                      <td>
                        {e.record.source === "st"
                          ? e.record.reference || e.record.id
                          : e.record.id}
                        <small className="block">
                          {e.record.source === "st"
                            ? "ServiceTitan PO"
                            : "QuickBooks card purchase"}
                        </small>
                        <small className="block">{e.record.vendor}</small>
                        {e.record.source === "st" && (
                          <small className="block">
                            {e.record.description}
                          </small>
                        )}
                      </td>
                      <td>{e.record.date}</td>
                      <td>{money(e.record.amount)}</td>
                      <td>
                        {e.record.source === "qbo" ? (
                          "—"
                        ) : e.vanStock ? (
                          <strong>VAN STOCK</strong>
                        ) : e.unknownPoType ? (
                          "Unclassified"
                        ) : (
                          "No"
                        )}
                      </td>
                      <td>
                        {e.record.source === "st" ? (
                          <>
                            {e.vanStockLabel && (
                              <strong>{e.vanStockLabel}</strong>
                            )}
                            <small className="block">{e.vanStockBasis}</small>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>{e.basis}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel">
        <h2>Van Stock definition</h2>
        <p>
          POs labeled VAN STOCK or VS in ServiceTitan count automatically. The
          PO type name must equal VAN STOCK or VS, or the PO number or summary
          must start with that label (for example, “VS: truck restock” or “[VAN
          STOCK] supplies”). Matching ignores capitalization and extra spaces.
          Mentions elsewhere in a summary do not count.
        </p>
        <p>
          This measures purchased stock dollars, not on-hand truck inventory
          value. ServiceTitan records are read-only. You can approve additional
          PO types below; these selections do not disable the label rule.
        </p>
        <form
          key={(state.vanStockTypeIds || []).join(",")}
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            await onSave({
              type: "scorecard-settings",
              vanStockTypeIds: f.getAll("type"),
              reason: f.get("reason"),
            });
          }}
        >
          <div className="type-choices">
            {state.directory?.poTypes.map((t) => (
              <label key={t.id}>
                <input
                  type="checkbox"
                  name="type"
                  value={t.id}
                  defaultChecked={
                    isVanStockTypeName(t.name) ||
                    state.vanStockTypeIds?.includes(t.id)
                  }
                  disabled={busy || isVanStockTypeName(t.name)}
                />
                {t.name}{" "}
                <small>
                  #{t.id}
                  {isVanStockTypeName(t.name) ? " · automatic label rule" : ""}
                  {!t.active ? " · inactive" : ""}
                </small>
              </label>
            ))}
          </div>
          {!state.directory?.poTypes.length && (
            <p>
              Refresh the ST / QB dropdowns on Card assignments to load PO
              types.
            </p>
          )}
          <label className="field">
            Reason
            <input
              name="reason"
              required
              minLength={5}
              maxLength={500}
              placeholder="Reason for additional PO types"
            />
          </label>
          <button disabled={busy || !state.directory?.poTypes.length}>
            Save additional PO types
          </button>
        </form>
      </section>
    </div>
  );
}
