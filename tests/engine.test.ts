import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, type RecordItem, type Rule } from "../lib/domain";
import { reconcile, normalize, fingerprint } from "../lib/engine";
import { seed } from "../lib/seed";
const rec = (
  id: string,
  source: "qbo" | "st",
  amount = 10000,
  extra: Partial<RecordItem> = {},
): RecordItem => ({
  id,
  source,
  amount,
  vendor: "Ferguson",
  date: "2026-09-01",
  currency: "USD",
  reference: "",
  description: "",
  account: "card",
  ...extra,
});
const run = (
  rows: RecordItem[],
  config = { ...defaults, maxGroup: 3 },
  rules: Rule[] = [],
) => reconcile(rows, config, rules, "2026-09-13");
test("exact 1:1 match has deterministic evidence", () => {
  const r = run([rec("q", "qbo"), rec("p", "st")])[0];
  assert.equal(r.status, "Matched");
  assert.equal(r.score, 90);
  assert.equal(r.difference, 0);
  assert.match(r.reasons[0], /vendor/);
});
test("1:many uses exact aggregate cents", () => {
  const r = run([
    rec("q", "qbo"),
    rec("p1", "st", 3000),
    rec("p2", "st", 7000),
  ])[0];
  assert.equal(r.kind, "1:many");
  assert.equal(r.status, "Matched");
});
test("many:1 supports split payments", () => {
  const r = run([
    rec("q1", "qbo", 3000),
    rec("q2", "qbo", 7000),
    rec("p", "st"),
  ])[0];
  assert.equal(r.kind, "many:1");
  assert.equal(r.difference, 0);
});
test("same-sign refunds match and are labeled", () => {
  const r = run([rec("q", "qbo", -10000), rec("p", "st", -10000)])[0];
  assert.equal(r.status, "Matched");
  assert.ok(r.flags.includes("Refund / credit"));
});
test("refund cannot cancel a positive PO", () =>
  assert.equal(
    run([rec("q", "qbo", -10000), rec("p", "st", 10000)]).filter(
      (r) => r.status === "Matched",
    ).length,
    0,
  ));
test("missing PO and orphan PO respect grace period", () => {
  const r = run([rec("q", "qbo"), rec("p", "st", 20000, { vendor: "Other" })]);
  assert.ok(r.some((r) => r.status === "Missing PO"));
  assert.ok(r.some((r) => r.status === "PO without charge"));
  assert.equal(
    run([rec("q", "qbo", 100, { date: "2026-09-12" })])[0].status,
    "Awaiting PO",
  );
});
test("late PO uses actual creation date, even when backdated", () => {
  const r = run([
    rec("q", "qbo"),
    rec("p", "st", 10000, { createdAt: "2026-09-08T00:00:00Z" }),
  ])[0];
  assert.equal(r.status, "Late PO");
});
test("underpayment with shared reference is partial", () =>
  assert.equal(
    run([
      rec("q", "qbo", 2000, { reference: "P1" }),
      rec("p", "st", 10000, { reference: "P1" }),
    ])[0].status,
    "Partial match",
  ));
test("overpayment with shared reference is amount mismatch, never auto", () =>
  assert.equal(
    run([
      rec("q", "qbo", 12000, { reference: "P1" }),
      rec("p", "st", 10000, { reference: "P1" }),
    ])[0].status,
    "Amount mismatch",
  ));
test("different vendors never match even if amounts agree", () =>
  assert.equal(
    run([rec("q", "qbo"), rec("p", "st", 10000, { vendor: "Unrelated" })])
      .length,
    2,
  ));
test("approved aliases only, punctuation normalizes deterministically", () => {
  const rule: Rule = {
    id: "alias",
    type: "alias",
    pattern: "FERG STORE 99",
    target: "Ferguson",
    approved: false,
    maxCents: 0,
    description: "Store alias",
  };
  assert.notEqual(normalize(rule.pattern, [rule]), "ferguson");
  rule.approved = true;
  assert.equal(normalize(rule.pattern, [rule]), "ferguson");
  assert.equal(normalize("Lowe’s"), normalize("Lowe's"));
});
test("no PO rule requires approval, exact vendor, positive amount and cap", () => {
  const rule: Rule = {
    id: "r",
    type: "no-po",
    pattern: "Ferguson",
    target: "",
    approved: false,
    maxCents: 15000,
    description: "Fleet fuel",
  };
  assert.equal(
    run([rec("q", "qbo")], defaults, [rule])[0].status,
    "Missing PO",
  );
  rule.approved = true;
  assert.equal(
    run([rec("q", "qbo")], defaults, [rule])[0].status,
    "No PO required",
  );
  assert.equal(
    run([rec("q", "qbo", 20000)], defaults, [rule])[0].status,
    "Missing PO",
  );
  assert.notEqual(
    run([rec("q", "qbo", -10000)], defaults, [rule])[0].status,
    "No PO required",
  );
});
test("possible duplicates never auto match or disappear under exemptions", () => {
  const r = run([rec("q1", "qbo"), rec("q2", "qbo"), rec("p", "st")]);
  assert.equal(r.filter((r) => r.status === "Matched").length, 0);
  assert.equal(r.filter((r) => r.status === "Possible duplicate").length, 2);
});
test("equal competing POs remain ambiguous", () => {
  const r = run([rec("q", "qbo"), rec("p1", "st"), rec("p2", "st")]);
  assert.equal(r.filter((r) => r.status === "Matched").length, 0);
  assert.ok(r.some((r) => r.status === "Ambiguous"));
});
test("group search cap fails closed", () => {
  const r = run([
    rec("q", "qbo"),
    ...Array.from({ length: 15 }, (_, i) => rec("p" + i, "st", 10000 + i)),
  ]);
  assert.ok(r.every((r) => r.status !== "Matched"));
});
test("date window excludes remote records", () =>
  assert.equal(
    run([rec("q", "qbo"), rec("p", "st", 10000, { date: "2026-07-01" })])
      .length,
    2,
  ));
test("tolerance is integer cents and threshold is configurable", () => {
  assert.equal(
    run([rec("q", "qbo", 10001), rec("p", "st")])[0].status,
    "Matched",
  );
  assert.equal(
    run([rec("q", "qbo"), rec("p", "st")], {
      ...defaults,
      autoThreshold: 95,
    })[0].status,
    "Needs review",
  );
});
test("invalid weights, currencies, dates, fractions, duplicate IDs rejected", () => {
  assert.throws(() =>
    run([rec("q", "qbo")], {
      ...defaults,
      weights: { vendor: 1, amount: 1, date: 1, reference: 1 },
    }),
  );
  for (const patch of [
    { amount: 1.5 },
    { date: "2026-02-30" },
    { currency: "EUR" },
  ])
    assert.throws(() => run([rec("q", "qbo", 100, patch as any)]));
  assert.throws(() => run([rec("q", "qbo"), rec("q", "st")]));
});
test("input ordering never changes the reconciliation", () => {
  const s = seed();
  assert.deepEqual(
    run(s.records, s.config, s.rules),
    run(s.records.slice().reverse(), s.config, s.rules),
  );
});
test("no source record is allocated twice", () => {
  const s = seed(),
    r = run(s.records, s.config, s.rules);
  const ids = r.flatMap((r) => [...r.charges, ...r.pos]);
  assert.equal(new Set(ids).size, s.records.length);
  assert.equal(ids.length, s.records.length);
});
test("manual decision survives rerun but source edits invalidate it", () => {
  const records = [rec("q", "qbo"), rec("p", "st")],
    r = run(records)[0];
  const d = {
    resultId: r.id,
    action: "confirm" as const,
    reason: "Receipt verified",
    actor: "test",
    at: "2026-09-13T00:00:00Z",
    charges: r.charges,
    pos: r.pos,
    fingerprint: fingerprint(records, ["q", "p"]),
  };
  assert.equal(
    reconcile(records, defaults, [], "2026-09-13", [d])[0].status,
    "Confirmed",
  );
  records[0].amount++;
  assert.notEqual(
    reconcile(records, defaults, [], "2026-09-13", [d])[0].status,
    "Confirmed",
  );
});
