import { test } from "node:test";
import assert from "node:assert/strict";
import { mapQBO, readQBO } from "../lib/integrations";
import { defaults, type RecordItem, type Rule } from "../lib/domain";
import { reconcile, fingerprint } from "../lib/engine";
import { emptyState } from "../lib/store";
import { suggestRules } from "../lib/suggestions";
import { reportCSV, filterResults } from "../lib/report";

const purchase = {
  Id: "1",
  PaymentType: "CreditCard",
  TotalAmt: 12.34,
  TxnDate: "2026-09-01",
  AccountRef: { value: "card" },
  PrivateNote: "For PO-123",
};
const po = (id: string, amount: number): RecordItem => ({
  id,
  amount,
  source: "st",
  vendor: "Ferguson",
  date: "2026-09-01",
  reference: "PO-123",
  account: "Richmond",
  currency: "USD",
  description: "",
});
const missing = (id: string, amount: number): RecordItem => ({
  ...mapQBO(purchase)!,
  id,
  amount,
});

test("vendorless QuickBooks purchases and refunds retain their original amounts, card IDs and references", () => {
  for (const EntityRef of [
    undefined,
    null,
    { value: "7" },
    { value: "7", name: null },
    { value: "7", name: " " },
  ]) {
    const q = mapQBO({ ...purchase, EntityRef })!;
    assert.equal(q.vendorMissing, true);
    assert.equal(q.vendor, "Vendor not specified in QuickBooks");
    assert.equal(q.amount, 1234);
    assert.equal(q.accountId, "card");
    assert.equal(q.reference, "PO-123");
    assert.equal(
      mapQBO({ ...purchase, EntityRef, Credit: true })!.amount,
      -1234,
    );
  }
  assert.equal(
    mapQBO({ ...purchase, EntityRef: { value: "7", name: "Ferguson" } })!
      .vendorMissing,
    undefined,
  );
});

test("one missing vendor no longer blocks importing other posted card purchases", async () => {
  const rows = await readQBO(
    "token",
    "realm",
    "2026-09-01",
    "2026-09-13",
    async (_url, init) => {
      assert.equal(init?.method, "GET");
      return Response.json({
        QueryResponse: {
          Purchase: [
            purchase,
            {
              ...purchase,
              Id: "2",
              EntityRef: { value: "7", name: "Ferguson" },
            },
          ],
        },
      });
    },
    ["card"],
  );
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.vendorMissing).length, 1);
  assert.equal(
    rows.reduce((sum, r) => sum + r.amount, 0),
    2468,
  );
});

test("missing vendor identity prevents 1:1, grouped and refund auto matches even with approved alias and exemption rules", () => {
  const rules: Rule[] = [
    {
      id: "alias",
      type: "alias",
      pattern: "Vendor not specified in QuickBooks",
      target: "Ferguson",
      approved: true,
      maxCents: 0,
      description: "Must not turn a placeholder into evidence",
    },
    {
      id: "no-po",
      type: "no-po",
      pattern: "Ferguson",
      target: "",
      approved: true,
      maxCents: 100000,
      description: "Approved vendor exception",
    },
  ];
  const cases = [
    [missing("q", 10000), po("p", 10000)],
    [missing("q", 10000), po("p1", 3000), po("p2", 7000)],
    [
      missing("q", 3000),
      { ...missing("q2", 7000), vendorMissing: false, vendor: "Ferguson" },
      po("p", 10000),
    ],
    [missing("q", -10000), po("p", -10000)],
  ];
  for (const input of cases) {
    const results = reconcile(input, defaults, rules, "2026-09-13");
    const q = results.filter((r) => r.charges.includes("q"));
    assert.equal(q.length, 1);
    assert.equal(q[0].status, "Missing vendor");
    assert.equal(q[0].score, 0);
    assert.deepEqual(q[0].pos, []);
    assert.equal(q[0].amount, input[0].amount);
  }
});

test("missing-vendor review remains in reports and cannot produce exemption suggestions", () => {
  const s = emptyState();
  s.records = ["01", "02", "03"].map((day, index) => ({
    ...missing("q" + index, 1234),
    date: "2026-09-" + day,
  }));
  const results = reconcile(s.records, defaults, [], "2026-09-13");
  assert.equal(filterResults(results, s, { status: "Needs review" }).length, 3);
  assert.deepEqual(suggestRules(s, results), []);
  assert.ok(reportCSV(s, results, {}).includes("Missing vendor"));
});

test("an explicit manual review of a missing vendor is audited by the source fingerprint and invalidates when vendor evidence changes", () => {
  const q = missing("q", 10000),
    p = po("p", 10000);
  const input = [q, p];
  const decision = {
    resultId: "manual",
    fingerprint: fingerprint(input, ["q", "p"]),
    action: "confirm" as const,
    reason: "Receipt manually verified against this PO",
    actor: "operator",
    at: "2026-09-13T12:00:00Z",
    charges: ["q"],
    pos: ["p"],
  };
  assert.equal(
    reconcile(input, defaults, [], "2026-09-13", [decision])[0].status,
    "Confirmed",
  );
  const corrected = [{ ...q, vendor: "Ferguson", vendorMissing: undefined }, p];
  assert.notEqual(fingerprint(corrected, ["q", "p"]), decision.fingerprint);
  assert.equal(
    reconcile(corrected, defaults, [], "2026-09-13", [decision])[0].status,
    "Matched",
  );
});
