import { test } from "node:test";
import assert from "node:assert/strict";
import { seed } from "../lib/seed";
import { applyAction, actionSchema } from "../lib/actions";
import { reconcile } from "../lib/engine";
import { verifyAudit } from "../lib/store";
import { mapQBO, readQBO } from "../lib/integrations";
import { reportCSV } from "../lib/report";
const mapping = (overrides: Record<string, unknown> = {}) =>
  actionSchema.parse({
    type: "save-card-mapping",
    revision: 1,
    mapping: {
      accountId: "demo-81",
      cardUser: "Jordan Smith",
      from: "2026-09-01",
      reason: "Verified employee card subaccount roster",
      ...overrides,
    },
  });
test("subaccount mapping covers its charges and linked POs, without touching other children", () => {
  const s = seed();
  applyAction(s, mapping(), "operator");
  assert.ok(
    s.records
      .filter((r) => r.accountId === "demo-81")
      .every((r) => r.cardUser === "Jordan Smith"),
  );
  assert.equal(
    s.records.find((r) => r.id === "Q-1042")?.cardUser,
    "Chris Parker",
  );
  const results = reconcile(s.records, s.config, s.rules, "2026-09-13");
  const csv = reportCSV(s, results, { individual: "Jordan Smith" });
  assert.ok(csv.includes("PO-2041"));
  assert.ok(csv.includes("demo-81"));
  assert.ok(!csv.includes("demo-82"));
  assert.ok(verifyAudit(s.audit));
});
test("effective dates and card reassignments preserve prior users", () => {
  const s = seed();
  applyAction(s, mapping({ through: "2026-09-09" }), "operator");
  applyAction(
    s,
    mapping({ from: "2026-09-10", cardUser: "Alex Morgan" }),
    "operator",
  );
  assert.equal(
    s.records.find((r) => r.id === "Q-1043")?.cardUser,
    "Jordan Smith",
  );
  assert.equal(
    s.records.find((r) => r.id === "Q-1041")?.cardUser,
    "Alex Morgan",
  );
  assert.throws(
    () =>
      applyAction(
        s,
        mapping({ from: "2026-09-09", through: "2026-09-09" }),
        "operator",
      ),
    /already has a mapping/,
  );
});
test("mapping date corrections restore imported ownership outside the period", () => {
  const s = seed();
  applyAction(s, mapping(), "operator");
  applyAction(
    s,
    mapping({ id: s.cardMappings![0].id, from: "2026-09-10" }),
    "operator",
  );
  assert.equal(
    s.records.find((r) => r.id === "Q-1043")?.cardUser,
    "Alex Morgan",
  );
  assert.equal(
    s.records.find((r) => r.id === "Q-1041")?.cardUser,
    "Jordan Smith",
  );
  assert.equal((s.audit[0].detail as any).after.from, "2026-09-01");
  assert.ok(verifyAudit(s.audit));
});
test("individual overrides take precedence and subaccount mappings survive sync", () => {
  const s = seed();
  applyAction(
    s,
    {
      type: "assign-card-user",
      revision: 1,
      chargeId: "Q-1041",
      cardUser: "Taylor Reed",
      reason: "Actual user on the receipt verified",
    },
    "operator",
  );
  applyAction(s, mapping(), "operator");
  s.mode = "live";
  applyAction(s, { type: "sync", revision: 1 }, "operator", seed().records);
  assert.equal(
    s.records.find((r) => r.id === "Q-1041")?.cardUser,
    "Taylor Reed",
  );
  assert.equal(
    s.records.find((r) => r.id === "Q-1045")?.cardUser,
    "Jordan Smith",
  );
});
test("parent, unknown subaccounts, missing edits and invalid dates fail closed", () => {
  const s = seed();
  assert.throws(() =>
    applyAction(s, mapping({ accountId: "unknown" }), "operator"),
  );
  assert.throws(() => applyAction(s, mapping({ id: "missing" }), "operator"));
  assert.throws(() => mapping({ from: "2026-02-30" }));
  assert.throws(() => mapping({ from: "2026-09-10", through: "2026-09-01" }));
  const before = process.env.QBO_PARENT_CC_ACCOUNT_ID;
  process.env.QBO_PARENT_CC_ACCOUNT_ID = "demo-81";
  try {
    assert.throws(() => applyAction(s, mapping(), "operator"), /parent/);
  } finally {
    if (before === undefined) delete process.env.QBO_PARENT_CC_ACCOUNT_ID;
    else process.env.QBO_PARENT_CC_ACCOUNT_ID = before;
  }
  assert.equal(s.cardMappings, undefined);
});
test("ownership mapping changes invalidate a manual reconciliation", () => {
  const s = seed(),
    r = reconcile(s.records, s.config, s.rules, "2026-09-13").find((r) =>
      r.charges.includes("Q-1041"),
    )!;
  applyAction(
    s,
    {
      type: "decision",
      revision: 1,
      resultId: r.id,
      action: "confirm",
      reason: "Receipt verified",
    },
    "operator",
  );
  applyAction(s, mapping(), "operator");
  assert.notEqual(
    reconcile(s.records, s.config, s.rules, "2026-09-13", s.decisions).find(
      (r) => r.charges.includes("Q-1041"),
    )?.status,
    "Confirmed",
  );
  assert.ok(
    (s.audit.at(-1)!.detail as any).invalidatedDecisionIds.includes(r.id),
  );
});
test("QBO preserves child account ID when two account labels are identical", () => {
  const raw = {
    Id: "1",
    PaymentType: "CreditCard",
    TotalAmt: 10,
    TxnDate: "2026-09-01",
    EntityRef: { value: "1", name: "Ferguson" },
    AccountRef: { value: "81", name: "Company card" },
  };
  assert.equal(mapQBO(raw)?.accountId, "81");
  assert.equal(
    mapQBO({ ...raw, AccountRef: { value: "82", name: "Company card" } })
      ?.accountId,
    "82",
  );
});
test("QBO child account allowlist excludes unrelated and parent purchases without double counting", async () => {
  const before = process.env.QBO_CARD_ACCOUNT_IDS;
  process.env.QBO_CARD_ACCOUNT_IDS = "81,82";
  try {
    const mock: typeof fetch = async () =>
      Response.json({
        QueryResponse: {
          Purchase: ["80", "81", "82", "99"].map((id, i) => ({
            Id: String(i),
            PaymentType: "CreditCard",
            TotalAmt: 10,
            TxnDate: "2026-09-01",
            EntityRef: { value: "1", name: "Ferguson" },
            AccountRef: { value: id },
          })),
        },
      });
    const result = await readQBO(
      "token",
      "realm",
      "2026-09-01",
      "2026-09-13",
      mock,
    );
    assert.deepEqual(
      result.map((r) => r.accountId),
      ["81", "82"],
    );
    assert.equal(
      result.reduce((n, r) => n + r.amount, 0),
      2000,
    );
  } finally {
    if (before === undefined) delete process.env.QBO_CARD_ACCOUNT_IDS;
    else process.env.QBO_CARD_ACCOUNT_IDS = before;
  }
});
