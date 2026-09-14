import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, type RecordItem, type Rule } from "../lib/domain";
import { reconcile } from "../lib/engine";
import { actionSchema, applyAction } from "../lib/actions";
import { seed } from "../lib/seed";
import { needsReview, reportCSV } from "../lib/report";
import { periodRange, scorecard } from "../lib/scorecard";
import { readState, changeState, verifyAudit } from "../lib/store";
import { POST } from "../app/api/actions/route";

const purchase = (id: string, extra: Partial<RecordItem> = {}): RecordItem => ({
  id,
  source: "qbo",
  vendor: "Wawa",
  amount: 12345,
  date: "2026-09-01",
  currency: "USD",
  reference: "",
  description: "Card purchase",
  account: "Employee card",
  accountId: "demo-81",
  cardUser: "Alex Morgan",
  ...extra,
});
const rule: Rule = {
  id: "fuel",
  type: "no-po",
  pattern: "Wawa",
  target: "",
  maxCents: null,
  approved: true,
  description: "All purchases at this fuel merchant are exempt",
};
const run = (records: RecordItem[], policy: Rule = rule) =>
  reconcile(records, defaults, [policy], "2026-09-14");

test("uncapped merchant exemption requires explicit approval and exact normalized vendor", () => {
  const high = purchase("high", { amount: 15000000 });
  assert.equal(run([high])[0].status, "No PO required");
  assert.match(run([high])[0].reasons.join(" "), /no amount limit/);
  assert.equal(
    run([high], { ...rule, approved: false })[0].status,
    "Missing PO",
  );
  assert.equal(
    run([high], { ...rule, maxCents: 15000 })[0].status,
    "Missing PO",
  );
  assert.equal(run([high], { ...rule, maxCents: 0 })[0].status, "Missing PO");
  assert.equal(
    run([purchase("case", { vendor: "WAWA" })])[0].status,
    "No PO required",
  );
  assert.equal(
    run([purchase("other", { vendor: "Wawa Office Supplies" })])[0].status,
    "Missing PO",
  );
});

test("fuel exemptions preserve duplicate, refund, missing-vendor and zero-amount review", () => {
  const results = run([
    purchase("dup1"),
    purchase("dup2"),
    purchase("refund", { amount: -12345 }),
    purchase("unknown", { vendorMissing: true, amount: 100 }),
    purchase("zero", { amount: 0 }),
    purchase("good", { amount: 1000 }),
  ]);
  const status = (id: string) =>
    results.find((r) => r.charges.includes(id))!.status;
  assert.equal(status("dup1"), "Possible duplicate");
  assert.equal(status("dup2"), "Possible duplicate");
  assert.equal(status("unknown"), "Payee not assigned");
  assert.notEqual(status("refund"), "No PO required");
  assert.notEqual(status("zero"), "No PO required");
  assert.equal(status("good"), "No PO required");
});

test("gas exemptions retain technician spend, exports and original PO source records", () => {
  const s = seed();
  s.rules = [rule];
  s.decisions = [];
  s.records = [
    purchase("fuel-charge"),
    {
      ...purchase("source-po"),
      source: "st",
      amount: 99999,
      reference: "PO-gas",
      date: "2026-09-01",
    },
  ];
  const before = structuredClone(s.records);
  const results = run(s.records);
  const fuel = results.find((r) => r.charges.includes("fuel-charge"))!;
  assert.equal(needsReview(fuel.status), false);
  assert.ok(results.some((r) => r.pos.includes("source-po")));
  assert.deepEqual(s.records, before);
  assert.match(reportCSV(s, results, {}), /No PO required/);
  assert.match(reportCSV(s, results, {}), /123.45/);
  const scores = scorecard(
    s,
    results,
    periodRange({ unit: "month", year: 2026, period: 9 }),
  );
  assert.equal(scores.total.spend, 12345);
  assert.equal(scores.total.poTotal, 99999);
});

test("updating a pending fuel suggestion preserves its ID and audit but never activates or alters an approved rule", () => {
  const s = seed();
  s.rules = [{ ...rule, maxCents: 10461, approved: false }];
  const input = actionSchema.parse({
    type: "suggest-rule",
    revision: s.revision,
    rule,
  });
  applyAction(s, input, "operator");
  assert.equal(s.rules.length, 1);
  assert.equal(s.rules[0].id, "fuel");
  assert.equal(s.rules[0].maxCents, null);
  assert.equal(s.rules[0].approved, false);
  const detail = s.audit.at(-1)!.detail as any;
  assert.equal(detail.before.maxCents, 10461);
  assert.equal(detail.after.maxCents, null);
  applyAction(
    s,
    { type: "approve-rule", revision: s.revision, id: "fuel" },
    "operator",
  );
  assert.equal(s.rules[0].approved, true);
  const before = structuredClone(s);
  assert.throws(
    () => applyAction(s, input, "operator"),
    /approved rule already/,
  );
  assert.deepEqual(s, before);
  assert.equal(detail.after.approved, false);
  assert.ok(verifyAudit(s.audit));
});

test("no amount limit is explicit: omitted, negative and fractional limits are rejected", () => {
  const input = {
    type: "suggest-rule",
    revision: 1,
    rule: { ...rule, maxCents: null },
  };
  assert.equal((actionSchema.parse(input) as any).rule.maxCents, null);
  for (const maxCents of [undefined, -1, 1.5, NaN])
    assert.throws(() =>
      actionSchema.parse({ ...input, rule: { ...rule, maxCents } }),
    );
});

test("rule API saves and reloads an uncapped proposal, then requires a separate audited approval", async () => {
  const previous = process.env.DEMO_MODE;
  process.env.DEMO_MODE = "true";
  try {
    let s = await readState();
    s = await changeState(s.revision, (state) => {
      state.records = [purchase("api-fuel")];
      state.rules = [];
      state.decisions = [];
    });
    const send = (body: object) =>
      POST(
        new Request("http://127.0.0.1:3000/api/actions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://127.0.0.1:3000",
          },
          body: JSON.stringify({ ...body, revision: s.revision }),
        }),
      );
    let response = await send({ type: "suggest-rule", rule });
    assert.equal(response.status, 200);
    s = await response.json();
    assert.equal((await readState()).rules[0].maxCents, null);
    assert.equal(s.rules[0].approved, false);
    assert.equal(
      reconcile(s.records, s.config, s.rules, "2026-09-14")[0].status,
      "Missing PO",
    );
    response = await send({ type: "approve-rule", id: s.rules[0].id });
    assert.equal(response.status, 200);
    s = await response.json();
    assert.equal(
      reconcile(s.records, s.config, s.rules, "2026-09-14")[0].status,
      "No PO required",
    );
    assert.equal(s.audit.at(-1)!.action, "Rule explicitly approved");
    assert.ok(verifyAudit(s.audit));
  } finally {
    if (previous === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = previous;
  }
});
