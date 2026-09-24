import { test } from "node:test";
import assert from "node:assert/strict";
import { seed } from "../lib/seed";
import { actionSchema, applyAction } from "../lib/actions";
import { reconcile } from "../lib/engine";
import { unmatchedTotals, reportCSV } from "../lib/report";
import { verifyAudit } from "../lib/store";
import type { RecordItem, State } from "../lib/domain";

const record = (
  id: string,
  source: "qbo" | "st",
  amount: number,
): RecordItem => ({
  id,
  source,
  amount,
  vendor: id,
  date: "2026-09-10",
  currency: "USD",
  reference: "",
  description: "",
  account: id,
  ...(source === "qbo" ? { cardUser: "Adam" } : {}),
});
function fixture() {
  const state = seed();
  state.records = [
    record("q1", "qbo", 4000),
    record("q2", "qbo", 6000),
    record("q3", "qbo", 2000),
    record("p1", "st", 10000),
    record("p2", "st", 3000),
  ];
  state.rules = [];
  state.decisions = [];
  state.audit = [];
  return state;
}
const results = (s: State) =>
  reconcile(s.records, s.config, s.rules, "2026-09-13", s.decisions);
function save(s: State, resultId: string, chargeIds: string[], poIds = ["p1"]) {
  applyAction(
    s,
    actionSchema.parse({
      type: "decision",
      revision: s.revision,
      resultId,
      chargeIds,
      poIds,
      action: "confirm",
    }),
    "reviewer",
  );
}
test("several charges reserve one PO, survive reload, extend later and invalidate when evidence changes", () => {
  const s = fixture();
  save(s, results(s).find((r) => r.pos.includes("p1"))!.id, ["q1", "q2"]);
  let match = results(s).find((r) => r.pos.includes("p1"))!;
  assert.equal(match.status, "Confirmed");
  assert.equal(match.kind, "many:1");
  assert.equal(match.difference, 0);
  assert.deepEqual(results(JSON.parse(JSON.stringify(s))), results(s));
  assert.equal(
    results(s)
      .flatMap((r) => r.pos)
      .filter((id) => id === "p1").length,
    1,
  );
  const before = structuredClone(s);
  assert.throws(
    () =>
      save(
        s,
        results(s).find((r) => r.charges.includes("q3"))!.id,
        ["q3", "q1"],
        ["p2"],
      ),
    /reserved/,
  );
  assert.deepEqual(s, before);
  save(s, match.id, ["q1", "q2", "q3"]);
  match = results(s).find((r) => r.pos.includes("p1"))!;
  assert.equal(match.difference, 2000);
  assert.equal(s.decisions.length, 1);
  assert.ok(verifyAudit(s.audit));
  const csv = reportCSV(s, results(s), {});
  assert.ok(csv.includes("q1") && csv.includes("q2") && csv.includes("p1"));
  s.records[0].amount++;
  assert.ok(results(s).every((r) => r.status !== "Confirmed"));
});
test("invalid, duplicate, unrelated and multi-PO selections leave state untouched", () => {
  const s = fixture(),
    id = results(s).find((r) => r.charges.includes("q1"))!.id;
  for (const [charges, pos] of [
    [["q1", "q1"], ["p1"]],
    [["q1", "missing"], ["p1"]],
    [["p2"], ["p1"]],
    [["q2"], ["p1"]],
    [["q1"], ["p1", "p2"]],
  ]) {
    const before = structuredClone(s);
    assert.throws(() => save(s, id, charges, pos));
    assert.deepEqual(s, before);
  }
});
test("unmatched totals follow filters, preserve credits and exclude exemptions and linked groups", () => {
  const s = fixture();
  s.records.push(record("refund", "qbo", -1000));
  let rows = results(s);
  assert.deepEqual(unmatchedTotals(rows, s, {}), {
    poCents: 13000,
    chargeCents: 11000,
    differenceCents: 2000,
  });
  assert.equal(unmatchedTotals(rows, s, { individual: "Adam" }).poCents, 0);
  assert.equal(unmatchedTotals(rows, s, { from: "2026-09-11" }).chargeCents, 0);
  assert.equal(unmatchedTotals(rows, s, { query: "p1" }).poCents, 10000);
  assert.equal(unmatchedTotals(rows, s, { status: "Missing PO" }).poCents, 0);
  save(s, rows.find((r) => r.pos.includes("p1"))!.id, ["q1", "q2"]);
  rows = results(s);
  assert.deepEqual(unmatchedTotals(rows, s, {}), {
    poCents: 3000,
    chargeCents: 1000,
    differenceCents: 2000,
  });
  rows = rows.map((r) =>
    r.charges.includes("q3") ? { ...r, status: "No PO required" } : r,
  );
  assert.equal(unmatchedTotals(rows, s, {}).chargeCents, -1000);
});
