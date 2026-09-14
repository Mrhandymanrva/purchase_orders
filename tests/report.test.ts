import { test } from "node:test";
import assert from "node:assert/strict";
import { seed } from "../lib/seed";
import { reconcile } from "../lib/engine";
import { cardUsers, filterResults, reportCSV } from "../lib/report";
import { applyAction } from "../lib/actions";
import { mapQBO } from "../lib/integrations";
test("individual filter links POs to actual charge owner", () => {
  const state = seed(),
    results = reconcile(state.records, state.config, state.rules, "2026-09-13");
  const filtered = filterResults(results, state, { individual: "Alex Morgan" });
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((r) => cardUsers(state, r).includes("Alex Morgan")));
  assert.ok(filtered.some((r) => r.pos.includes("PO-2041")));
  const csv = reportCSV(state, results, { individual: "Alex Morgan" });
  assert.ok(csv.includes("PO-2041"));
  assert.ok(!csv.includes("Chris Parker"));
  assert.equal(csv.split("\r\n").length - 1, 5);
});
test("shared-PO report includes only selected person charges and retains group link", () => {
  const state = seed();
  state.config.maxGroup = 3;
  state.records.find((r) => r.id === "Q-1047")!.cardUser = "Alex Morgan";
  const results = reconcile(
    state.records,
    state.config,
    state.rules,
    "2026-09-13",
  );
  const csv = reportCSV(state, results, {
    individual: "Alex Morgan",
    from: "2026-09-10",
    to: "2026-09-10",
  });
  assert.ok(csv.includes("Q-1047"));
  assert.ok(csv.includes("PO-2047"));
  assert.ok(!csv.includes("Q-1046"));
});
test("manual ownership persists after source sync and leaves audit evidence", () => {
  const state = seed();
  state.mode = "live";
  applyAction(
    state,
    {
      type: "assign-card-user",
      revision: 1,
      chargeId: "Q-1055",
      cardUser: "Jordan Smith",
      reason: "Verified the individual statement",
    },
    "manager",
  );
  const snapshot = seed().records;
  applyAction(state, { type: "sync", revision: 1 }, "manager", snapshot);
  assert.equal(
    state.records.find((r) => r.id === "Q-1055")?.cardUser,
    "Jordan Smith",
  );
  assert.equal(state.audit[0].action, "Card user assigned");
});
test("cardholder custom field outranks explicit account mapping; unknown stays unassigned", () => {
  const raw = {
    Id: "1",
    PaymentType: "CreditCard",
    TotalAmt: 10,
    TxnDate: "2026-09-01",
    EntityRef: { value: "1", name: "Ferguson" },
    AccountRef: { value: "card-1" },
  };
  process.env.QBO_CARDHOLDERS_JSON = '{"card-1":"Alex Morgan"}';
  process.env.QBO_CARDHOLDER_FIELD = "Card user";
  assert.equal(mapQBO(raw)?.cardUser, "Alex Morgan");
  assert.equal(
    mapQBO({
      ...raw,
      CustomField: [{ Name: "Card user", StringValue: "Jordan Smith" }],
    })?.cardUser,
    "Jordan Smith",
  );
  assert.equal(
    mapQBO({ ...raw, AccountRef: { value: "unknown" } })?.cardUser,
    "Unassigned",
  );
});
test("CSV neutralizes spreadsheet formulas without losing numeric credit signs", () => {
  const state = seed();
  const q = state.records.find((r) => r.source === "qbo")!;
  q.cardUser = '=HYPERLINK("bad")';
  q.amount = -100;
  const csv = reportCSV(
    state,
    reconcile(state.records, state.config, state.rules, "2026-09-13"),
    {},
  );
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes('"-1"'));
});
