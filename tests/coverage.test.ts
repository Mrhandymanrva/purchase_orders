import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, type RecordItem, type State } from "../lib/domain";
import { reconcile, fingerprint } from "../lib/engine";
import { filterResults, needsReview, reportCSV } from "../lib/report";
import { periodRange, scorecard } from "../lib/scorecard";
import { seed } from "../lib/seed";
import { applyAction } from "../lib/actions";
import { readState, changeState, verifyAudit } from "../lib/store";
import { GET as report } from "../app/api/report/route";

const coverage = {
  chargesFrom: "2026-09-01",
  posFrom: "2026-06-03",
  through: "2026-09-13",
};
const po = (id: string, date: string, amount = 10000): RecordItem => ({
  id,
  source: "st",
  date,
  amount,
  vendor: "Ferguson",
  currency: "USD",
  reference: id,
  description: "VAN STOCK",
  account: "Richmond",
  poStatus: "Pending",
});
const run = (records: RecordItem[], history: State["coverage"] = coverage) =>
  reconcile(records, defaults, [], "2026-09-13", [], history);

test("unlinked POs outside card history stay visible without becoming unpaid exceptions", () => {
  const records = [
    po("old", "2026-07-15"),
    po("first", "2026-09-01"),
    po("last", "2026-09-13"),
    po("later", "2026-09-14"),
  ];
  const before = structuredClone(records);
  const results = run(records);
  const status = (id: string) =>
    results.find((r) => r.pos.includes(id))!.status;
  assert.equal(status("old"), "Outside card coverage");
  assert.equal(status("later"), "Outside card coverage");
  assert.equal(status("first"), "PO without charge");
  assert.equal(status("last"), "Awaiting charge");
  assert.equal(results.length, records.length);
  assert.deepEqual(records, before);
  assert.match(
    results.find((r) => r.pos.includes("old"))!.reasons.join(" "),
    /2026-09-01 through 2026-09-13/,
  );
});

test("lookback POs can still match imported charges across the coverage boundary", () => {
  const records = [
    po("p", "2026-08-31"),
    { ...po("q", "2026-09-01"), source: "qbo" as const, reference: "p" },
  ];
  const result = run(records);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, "Matched");
  assert.deepEqual(result[0].pos, ["p"]);
  assert.deepEqual(result[0].charges, ["q"]);
});

test("expanded or unknown card history does not suppress a PO exception, and invalid bounds fail closed", () => {
  const records = [po("old", "2026-07-15")];
  assert.equal(
    run(records, { ...coverage, chargesFrom: "2026-06-01" })[0].status,
    "PO without charge",
  );
  assert.equal(
    reconcile(records, defaults, [], "2026-09-13")[0].status,
    "PO without charge",
  );
  assert.throws(() => run(records, { ...coverage, chargesFrom: "2026-02-30" }));
  assert.throws(
    () => run(records, { ...coverage, chargesFrom: "2026-09-14" }),
    /starts after/,
  );
});

test("coverage context is excluded from review and variance but retained in exports and PO scorecard totals", () => {
  const s = seed();
  s.records = [
    po("old", "2026-07-15", 50000),
    po("current", "2026-09-01", 25000),
  ];
  s.coverage = coverage;
  const results = run(s.records);
  assert.deepEqual(
    filterResults(results, s, { status: "Needs review" }).flatMap((r) => r.pos),
    ["current"],
  );
  assert.equal(
    results
      .filter((r) => needsReview(r.status))
      .reduce((sum, r) => sum + Math.abs(r.difference), 0),
    25000,
  );
  assert.equal(
    filterResults(results, s, { status: "Outside card coverage" }).length,
    1,
  );
  assert.match(reportCSV(s, results, {}), /Outside card coverage/);
  assert.doesNotMatch(reportCSV(s, results, { status: "Needs review" }), /old/);
  const july = scorecard(
    s,
    results,
    periodRange({ unit: "month", year: 2026, period: 7 }),
  );
  assert.equal(july.total.poTotal, 50000);
  assert.equal(july.total.vanStock, 50000);
});

test("explicit manual decisions retain precedence over missing card coverage", () => {
  const records = [po("old", "2026-07-15")];
  const result = reconcile(
    records,
    defaults,
    [],
    "2026-09-13",
    [
      {
        resultId: JSON.stringify([[], ["old"]]),
        charges: [],
        pos: ["old"],
        fingerprint: fingerprint(records, ["old"]),
        action: "dismiss",
        actor: "operator",
        reason: "Verified vendor-account payment",
        at: "2026-09-13T12:00:00Z",
      },
    ],
    coverage,
  );
  assert.equal(result[0].status, "Dismissed");
});

test("sync audit records coverage with its engine results for reproducible review counts", () => {
  const s = seed();
  s.records = [po("old", "2026-07-15")];
  applyAction(
    s,
    { type: "sync", revision: s.revision },
    "operator",
    undefined,
    undefined,
    coverage,
  );
  const detail = s.audit.at(-1)!.detail as any;
  assert.deepEqual(detail.coverage, coverage);
  assert.equal(detail.engine, "1.0.2");
  assert.equal(detail.results[0].status, "Outside card coverage");
  assert.ok(verifyAudit(s.audit));
});

test("report API applies stored coverage consistently to all-items and review exports", async () => {
  const prior = process.env.DEMO_MODE;
  process.env.DEMO_MODE = "true";
  try {
    const initial = await readState();
    await changeState(initial.revision, (s) => {
      s.records = [
        po("outside-po", "2026-07-15"),
        po("current-po", "2026-09-01"),
      ];
      s.coverage = coverage;
      s.rules = [];
      s.decisions = [];
    });
    const all = await report(new Request("http://localhost:3000/api/report"));
    assert.equal(all.status, 200);
    assert.match(await all.text(), /Outside card coverage/);
    const review = await report(
      new Request("http://localhost:3000/api/report?status=Needs%20review"),
    );
    assert.equal(review.status, 200);
    const csv = await review.text();
    assert.match(csv, /current-po/);
    assert.doesNotMatch(csv, /outside-po/);
  } finally {
    if (prior === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = prior;
  }
});
