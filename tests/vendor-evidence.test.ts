import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "csv-parse/sync";
import { mapQBO, readQBO } from "../lib/integrations";
import { defaults, type RecordItem, type Rule } from "../lib/domain";
import { reconcile, fingerprint } from "../lib/engine";
import {
  resolveVendorDescription,
  LOWES_DESCRIPTION_RULE,
} from "../lib/vendor-evidence";
import { emptyState, verifyAudit } from "../lib/store";
import { applyAction } from "../lib/actions";
import { reportCSV, needsReview } from "../lib/report";
import { scorecard } from "../lib/scorecard";

const raw = {
  Id: "75890",
  PaymentType: "CreditCard",
  TotalAmt: 50.37,
  Credit: true,
  TxnDate: "2026-09-04",
  AccountRef: { value: "card" },
  PrivateNote: "LOWES #X1037*",
};
const alias: Rule = {
  id: "approved-lowes",
  type: "alias",
  pattern: "Lowe's",
  target: "2 Lowes",
  maxCents: 0,
  approved: true,
  description: "Operator approved vendor alias",
};
const po: RecordItem = {
  id: "ST:credit",
  source: "st",
  vendor: "2 Lowes",
  amount: -5037,
  date: "2026-09-04",
  reference: "PO-credit",
  description: "Credit",
  account: "Richmond",
  currency: "USD",
};

test("Lowe's store descriptions identify a merchant on purchases and refunds with retained source evidence", () => {
  for (const PrivateNote of [
    "LOWES #X1037*",
    "LOWES #X0599* LOWES #X0632*",
    "  Lowe’s #1037  ",
  ]) {
    for (const Credit of [false, true]) {
      const r = mapQBO({ ...raw, PrivateNote, Credit })!;
      assert.equal(r.vendor, "Lowe's");
      assert.equal(r.vendorMissing, undefined);
      assert.equal(r.amount, Credit ? -5037 : 5037);
      assert.equal(r.id, "QBO:75890");
      assert.equal(r.accountId, "card");
      assert.equal(r.description, PrivateNote);
      assert.deepEqual(r.vendorEvidence, {
        source: "QuickBooks.PrivateNote",
        text: PrivateNote,
        rule: LOWES_DESCRIPTION_RULE,
      });
      assert.deepEqual(resolveVendorDescription(r), r);
    }
  }
});

test("explicit QuickBooks payees take precedence and arbitrary or conflicting notes are never inferred as Lowe's", () => {
  const named = mapQBO({
    ...raw,
    EntityRef: { value: "other", name: "Other vendor" },
  })!;
  assert.equal(named.vendor, "Other vendor");
  assert.equal(named.vendorEvidence, undefined);
  for (const PrivateNote of [
    "",
    "For PO-123",
    "Refund from LOWES #X1037*",
    "NOT LOWES #X1037*",
    "LOWES #X1037* SHELL #13",
    "LOWES #X1037* for customer",
    "LOWES #X1037*\nDO NOT MATCH",
    "LOWES PAINTING #1037",
    "LOWES #X1037FAKE",
    "LOWES #123456789",
    "LOWES",
    "SIEWERS LUMBER AND MILLWO",
  ]) {
    const r = mapQBO({ ...raw, PrivateNote })!;
    assert.equal(r.vendorMissing, true, PrivateNote);
    assert.equal(r.vendorEvidence, undefined, PrivateNote);
  }
  assert.deepEqual(
    resolveVendorDescription({
      ...po,
      vendorMissing: true,
      description: raw.PrivateNote,
    }),
    { ...po, vendorMissing: true, description: raw.PrivateNote },
  );
});

test("read-only QBO import recognizes descriptions only within selected card accounts", async () => {
  let calls = 0;
  const rows = await readQBO(
    "token",
    "realm",
    "2026-09-01",
    "2026-09-14",
    async (_url, init) => {
      calls++;
      assert.equal(init?.method, "GET");
      return Response.json({
        QueryResponse: {
          Purchase: [
            raw,
            { ...raw, Id: "other-card", AccountRef: { value: "excluded" } },
            { ...raw, Id: "unknown", PrivateNote: "Unverified merchant" },
          ],
        },
      });
    },
    ["card"],
  );
  assert.equal(calls, 1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].vendor, "Lowe's");
  assert.equal(rows[1].vendorMissing, true);
});

test("recognized refunds require approved aliases and normal matching evidence, never fuel exemptions", () => {
  const q = mapQBO(raw)!;
  const run = (records: RecordItem[], rules: Rule[] = []) =>
    reconcile(records, defaults, rules, "2026-09-14");
  assert.equal(run([q])[0].status, "Unallocated refund");
  assert.equal(run([q])[0].kind, "Card refund / credit");
  assert.ok(needsReview(run([q])[0].status));
  assert.ok(
    run([q, po], [{ ...alias, approved: false }]).every(
      (r) => r.status !== "Matched",
    ),
  );
  const matched = run([q, po], [alias]);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].status, "Matched");
  assert.ok(
    matched[0].reasons.some(
      (r) => r.includes(raw.PrivateNote) && r.includes(LOWES_DESCRIPTION_RULE),
    ),
  );
  assert.ok(
    run([q, { ...po, amount: 5037 }], [alias]).every(
      (r) => r.status !== "Matched",
    ),
  );
  assert.equal(
    run([q], [{ ...alias, type: "no-po", maxCents: null }])[0].status,
    "Unallocated refund",
  );
  assert.ok(
    run([q, { ...q, id: "duplicate" }], [alias]).every(
      (r) => r.status === "Possible duplicate",
    ),
  );
});

test("unverified descriptions are visible but remain outside authoritative matching and exemptions", () => {
  const q = mapQBO({
    ...raw,
    PrivateNote: "SIEWERS LUMBER AND MILLWO",
    Credit: false,
  })!;
  const r = reconcile(
    [q, { ...po, vendor: q.description, amount: 5037 }],
    defaults,
    [{ ...alias, type: "no-po", pattern: q.description, maxCents: null }],
    "2026-09-14",
  ).find((r) => r.charges.includes(q.id))!;
  assert.equal(r.vendor, "Description: SIEWERS LUMBER AND MILLWO");
  assert.equal(r.status, "Payee not assigned");
  assert.equal(r.score, 0);
  assert.deepEqual(r.pos, []);
  assert.ok(needsReview(r.status));
  assert.equal(
    reconcile(
      [mapQBO({ ...raw, PrivateNote: "" })!],
      defaults,
      [],
      "2026-09-14",
    )[0].status,
    "Missing vendor",
  );
});

test("reports and scorecards retain signed refunds and show merchant evidence separately from the source description", () => {
  const s = emptyState();
  s.records = [
    mapQBO(raw)!,
    mapQBO({
      ...raw,
      Id: "unknown",
      Credit: false,
      PrivateNote: "Other merchant",
    })!,
    po,
  ];
  const results = reconcile(s.records, s.config, [], "2026-09-14");
  const rows = parse(reportCSV(s, results, {}), { columns: true, bom: true });
  const refund = rows.find((r: any) => r["Charge ID"] === "QBO:75890");
  assert.equal(refund.Vendor, "Lowe's");
  assert.equal(refund["Amount USD"], "-50.37");
  assert.equal(refund["QuickBooks description"], raw.PrivateNote);
  assert.equal(refund["Merchant recognition rule"], LOWES_DESCRIPTION_RULE);
  assert.match(refund["Vendor evidence"], /description; payee not assigned/);
  const unknown = rows.find((r: any) => r["Charge ID"] === "QBO:unknown");
  assert.equal(unknown["QuickBooks description"], "Other merchant");
  assert.match(unknown["Vendor evidence"], /unverified/);
  assert.equal(rows.length, 3);
  const scores = scorecard(s, results, {
    from: "2026-09-01",
    to: "2026-09-30",
  });
  assert.equal(scores.total.spend, 0);
  assert.equal(scores.total.chargeCount, 2);
  assert.equal(scores.total.poTotal, -5037);
});

test("sync audits changed vendor evidence and invalidates earlier manual decisions instead of silently reusing them", () => {
  const s = emptyState();
  s.mode = "demo";
  const resolved = mapQBO(raw)!;
  const { vendorEvidence: _evidence, ...base } = resolved;
  const prior = {
    ...base,
    vendor: "Vendor not specified in QuickBooks",
    vendorMissing: true,
  };
  s.records = [prior];
  s.decisions = [
    {
      resultId: "manual-old",
      charges: [prior.id],
      pos: [],
      fingerprint: fingerprint(s.records, [prior.id]),
      action: "dismiss",
      actor: "operator",
      at: "2026-09-13T00:00:00Z",
      reason: "Reviewed earlier evidence",
    },
  ];
  assert.notEqual(
    fingerprint([resolved], [resolved.id]),
    s.decisions[0].fingerprint,
  );
  applyAction(s, { type: "sync", revision: s.revision }, "operator", [
    resolved,
  ]);
  const detail = s.audit.at(-1)!.detail as any;
  assert.deepEqual(detail.invalidatedDecisions, ["manual-old"]);
  assert.match(detail.sourceFingerprint, /qbo-lowes-store-v1/);
  assert.equal(detail.results[0].status, "Unallocated refund");
  assert.ok(verifyAudit(s.audit));
});
