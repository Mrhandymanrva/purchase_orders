import { test } from "node:test";
import assert from "node:assert/strict";
import { seed } from "../lib/seed";
import { applyAction, actionSchema } from "../lib/actions";
import { reconcile } from "../lib/engine";
import { verifyAudit } from "../lib/store";
import { mapQBO, readQBO } from "../lib/integrations";
import { reportCSV } from "../lib/report";
import { applyOwnership } from "../lib/ownership";
const mapping = (overrides: Record<string, unknown> = {}) =>
  actionSchema.parse({
    type: "save-card-mapping",
    revision: 1,
    mapping: {
      accountId: "demo-81",
      cardUser: "Jordan Smith",
      reason: "Verified employee card subaccount roster",
      ...overrides,
    },
  });

test("legacy duplicate mappings cannot silently choose an owner", () => {
  const s = seed();
  const legacy = {
    id: "old-1",
    accountId: "demo-81",
    cardUser: "Alex Morgan",
    reason: "Legacy import",
    from: "2020-01-01",
    through: "2025-12-31",
  };
  s.cardMappings = [
    legacy,
    {
      ...legacy,
      id: "old-2",
      cardUser: "Chris Parker",
      from: "2026-01-01",
      through: undefined,
    },
  ];
  assert.throws(() => applyOwnership(s.records, s), /Multiple mappings/);
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
test("permanent mappings cover historical purchases, future purchases and refunds without dates", () => {
  const s = seed();
  const original = s.records.find((r) => r.accountId === "demo-81")!;
  s.records.push(
    { ...original, id: "old", date: "2020-01-01" },
    { ...original, id: "future-refund", date: "2030-01-01", amount: -100 },
  );
  applyAction(
    s,
    mapping({ from: "2026-09-13", through: "2026-09-14" }),
    "operator",
  );
  assert.ok(
    s.records
      .filter((r) => r.accountId === "demo-81")
      .every((r) => r.cardUser === "Jordan Smith"),
  );
  assert.equal(s.cardMappings![0].from, undefined);
  assert.equal(s.cardMappings![0].through, undefined);
  const id = s.cardMappings![0].id;
  applyAction(s, mapping({ cardUser: "Alex Morgan" }), "operator");
  assert.equal(s.cardMappings!.length, 1);
  assert.equal(s.cardMappings![0].id, id);
  assert.ok(
    s.records
      .filter((r) => r.accountId === "demo-81")
      .every((r) => r.cardUser === "Alex Morgan"),
  );
  assert.ok(verifyAudit(s.audit));
});

test("closed cards and inactive employees retain historical identity after refresh and sync", () => {
  const s = seed();
  applyAction(
    s,
    mapping({ cardUser: "Alex Morgan", personId: "technician:demo-1" }),
    "operator",
  );
  const directory = structuredClone(s.directory!);
  directory.people = directory.people.filter(
    (p) => p.id !== "technician:demo-1",
  );
  directory.accounts.find((a) => a.id === "demo-81")!.active = false;
  applyAction(
    s,
    { type: "refresh-directory", revision: 1 },
    "operator",
    undefined,
    directory,
  );
  s.mode = "live";
  applyAction(
    s,
    { type: "sync", revision: 1 },
    "operator",
    seed().records,
    directory,
  );
  assert.equal(s.cardMappings!.length, 1);
  assert.ok(
    s.records
      .filter((r) => r.accountId === "demo-81")
      .every((r) => r.cardPersonId === "technician:demo-1"),
  );
  assert.equal(
    s.records.find((r) => r.accountId === "demo-82")!.cardUser,
    "Chris Parker",
  );
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
test("parent, unknown subaccounts and missing edits fail closed", () => {
  const s = seed();
  assert.throws(() =>
    applyAction(s, mapping({ accountId: "unknown" }), "operator"),
  );
  assert.throws(() => applyAction(s, mapping({ id: "missing" }), "operator"));
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
