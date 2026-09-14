import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { type RecordItem, type State, type Rule } from "../lib/domain";
import { seed } from "../lib/seed";
import { actionSchema, applyAction } from "../lib/actions";
import { reconcile, fingerprint, ENGINE_VERSION } from "../lib/engine";
import { exclusionDraft } from "../lib/vendor-rule";
import { reportCSV, needsReview } from "../lib/report";
import { reconciliationPDFModel } from "../lib/pdf-report-model";
import { scorecard } from "../lib/scorecard";
import {
  changeState,
  readState,
  readDB,
  persistDB,
  verifyAudit,
  type DB,
} from "../lib/store";
import { POST } from "../app/api/actions/route";

const record = (id: string, extra: Partial<RecordItem> = {}): RecordItem => ({
  id,
  source: "qbo",
  vendor: "Vendor not specified in QuickBooks",
  vendorMissing: true,
  description: "DODGE STORE #8204",
  amount: 9772,
  date: "2026-09-08",
  reference: "",
  currency: "USD",
  account: id,
  accountId: id,
  cardUser: "Anthony C.",
  ...extra,
});
function fixture() {
  const s = seed();
  s.records = [record("q")];
  s.rules = [];
  s.decisions = [];
  return s;
}
const run = (s: State) =>
  reconcile(
    s.records,
    s.config,
    s.rules,
    "2026-09-13",
    s.decisions,
    s.coverage,
  );
const save = (s: State, recordId = "q", maxCents: number | null = null) =>
  applyAction(
    s,
    actionSchema.parse({
      type: "save-vendor-exclusion",
      revision: s.revision,
      approve: true,
      recordId,
      maxCents,
    }),
    "operator",
  );

test("the modal derives an exact description exclusion for a missing-payee purchase and applies it without changing source identity", () => {
  const s = fixture(),
    before = structuredClone(s.records);
  assert.equal(run(s)[0].status, "Payee not assigned");
  save(s);
  assert.equal(s.rules[0].matchField, "description");
  assert.equal(s.rules[0].pattern, "DODGE STORE #8204");
  assert.equal(s.rules[0].approved, true);
  const result = run(s)[0];
  assert.equal(result.status, "No PO required");
  assert.equal(needsReview(result.status), false);
  assert.deepEqual(result.pos, []);
  assert.match(
    result.reasons.join(" "),
    /Explicitly approved full QuickBooks description/,
  );
  assert.deepEqual(s.records, before);
  assert.equal(s.records[0].vendorMissing, true);
  assert.equal(exclusionDraft(record("blank", { description: "" })), null);
});

test("description rules require explicit approval, full text and unassigned payee; future matching purchases inherit the rule", () => {
  const s = fixture();
  save(s);
  const policy = s.rules[0];
  for (const [description, eligible] of [
    ["  dodge   store #8204  ", true],
    ["DODGE STORE #82040", false],
    ["DODGE STORE #8205", false],
    ["DODGE STORE 8204", false],
    ["Invoice from DODGE STORE #8204 for tools", false],
  ] as const) {
    s.records = [record("new-import", { description })];
    assert.equal(run(s)[0].status === "No PO required", eligible);
  }
  s.records = [
    record("known", { vendorMissing: false, vendor: "Other merchant" }),
  ];
  assert.notEqual(run(s)[0].status, "No PO required");
  s.records = [record("q")];
  s.rules = [{ ...policy, approved: false }];
  assert.equal(run(s)[0].status, "Payee not assigned");
  assert.deepEqual(run(s)[0].pos, []);
});

test("description exclusions preserve duplicate, refund, zero and above-cap review", () => {
  const s = fixture();
  save(s, "q", 10000);
  s.records = [
    record("good"),
    record("dup1", { accountId: "same" }),
    record("dup2", { accountId: "same" }),
    record("refund", { amount: -9772 }),
    record("zero", { amount: 0 }),
    record("large", { amount: 10001 }),
  ];
  const results = run(s),
    status = (id: string) =>
      results.find((r) => r.charges.includes(id))!.status;
  assert.equal(status("good"), "No PO required");
  assert.equal(status("dup1"), "Possible duplicate");
  assert.equal(status("dup2"), "Possible duplicate");
  for (const id of ["refund", "zero", "large"])
    assert.notEqual(status(id), "No PO required");
  const ids = results.flatMap((r) => [...r.charges, ...r.pos]);
  assert.equal(ids.length, s.records.length);
  assert.equal(new Set(ids).size, ids.length);
});

test("vendor exclusions use approved aliases, reuse pending rules, and preserve manual reservations", () => {
  const s = fixture();
  s.records = [
    record("q", {
      vendor: "HOME DEPOT",
      vendorMissing: false,
      description: "",
    }),
    record("manual", { vendor: "HOME DEPOT", vendorMissing: false }),
    {
      ...record("p"),
      source: "st",
      vendorMissing: false,
      vendor: "1 Home Depot",
    },
  ];
  s.rules = [
    {
      id: "alias",
      type: "alias",
      pattern: "Home Depot",
      target: "1 Home Depot",
      maxCents: 0,
      approved: true,
      description: "Approved alias",
    },
    {
      id: "pending",
      type: "no-po",
      pattern: "1 Home Depot",
      target: "",
      maxCents: 100,
      approved: false,
      description: "Awaiting decision",
    },
  ];
  s.decisions = [
    {
      resultId: "manual",
      charges: ["manual"],
      pos: [],
      action: "confirm",
      reason: "Receipt checked",
      actor: "operator",
      at: "2026-09-13T00:00:00Z",
      fingerprint: fingerprint(s.records, ["manual"]),
    },
  ];
  const before = structuredClone(s.decisions);
  save(s);
  assert.equal(s.rules.length, 2);
  assert.equal(s.rules[1].id, "pending");
  assert.equal(s.rules[1].approved, true);
  assert.equal(s.rules[1].maxCents, null);
  assert.equal(
    run(s).find((r) => r.charges.includes("manual"))!.status,
    "Confirmed",
  );
  assert.deepEqual(s.decisions, before);
  assert.equal(
    run(s).find((r) => r.charges.includes("q"))!.status,
    "No PO required",
  );
  assert.ok(run(s).some((r) => r.pos.includes("p")));
  save(s, "q", 5000);
  assert.equal(s.rules.length, 2);
  assert.equal(s.rules[1].maxCents, 5000);
  assert.ok(verifyAudit(s.audit));
});

test("generic saved vendor rules and pending approvals audit immediate reconciliation; unrelated suggestions stay pending", () => {
  const s = fixture();
  s.records = [
    record("q", { vendor: "Dodge Store", vendorMissing: false }),
    record("other", { vendor: "Hardware", vendorMissing: false }),
  ];
  const input = {
    type: "no-po" as const,
    pattern: "Dodge Store",
    target: "",
    maxCents: null,
    description: "Approved fuel merchant exemption",
  };
  s.rules = [
    { ...input, id: "unrelated", pattern: "Hardware", approved: false },
  ];
  applyAction(
    s,
    actionSchema.parse({
      type: "save-rule",
      revision: s.revision,
      approve: true,
      rule: input,
    }),
    "operator",
  );
  assert.equal(
    run(s).find((r) => r.charges.includes("q"))!.status,
    "No PO required",
  );
  assert.equal(s.rules[0].approved, false);
  const d = s.audit.at(-1)!.detail as any;
  assert.equal(d.reconciliation.engine, ENGINE_VERSION);
  assert.deepEqual(d.reconciliation.results, run(s));
  assert.equal(d.reconciliation.statusCountsBefore["Awaiting PO"], 2);
  assert.equal(d.reconciliation.statusCountsAfter["No PO required"], 1);
  applyAction(
    s,
    { type: "approve-rule", revision: s.revision, id: "unrelated" },
    "operator",
  );
  assert.ok(run(s).every((r) => r.status === "No PO required"));
  assert.deepEqual(
    (s.audit.at(-1)!.detail as any).reconciliation.results,
    run(s),
  );
  assert.ok(verifyAudit(s.audit));
});

test("exclusions keep spend and PO amounts in reports and scorecards", () => {
  const s = fixture();
  save(s);
  const results = run(s);
  assert.match(reportCSV(s, results, {}), /No PO required/);
  assert.match(reportCSV(s, results, {}), /97.72/);
  assert.equal(
    reconciliationPDFModel(s, results, {}).metrics[0].value,
    "$97.72",
  );
  assert.equal(reconciliationPDFModel(s, results, {}).metrics[2].value, "0");
  assert.equal(
    scorecard(s, results, { from: "2026-09-01", to: "2026-09-30" }).total.spend,
    9772,
  );
});

test("rule saves require an explicit approve flag and reject invalid inputs without mutations", () => {
  const s = fixture(),
    before = structuredClone(s);
  for (const approve of [undefined, false])
    assert.equal(
      actionSchema.safeParse({
        type: "save-vendor-exclusion",
        revision: 1,
        approve,
        recordId: "q",
        maxCents: null,
      }).success,
      false,
    );
  for (const maxCents of [-1, 1.5, undefined])
    assert.equal(
      actionSchema.safeParse({
        type: "save-vendor-exclusion",
        revision: 1,
        approve: true,
        recordId: "q",
        maxCents,
      }).success,
      false,
    );
  assert.throws(() => save(s, "missing"), /Source record/);
  assert.deepEqual(s, before);
  assert.equal(
    actionSchema.safeParse({
      type: "save-rule",
      revision: 1,
      approve: true,
      rule: { ...exclusionDraft(s.records[0]), type: "alias", target: "Dodge" },
    }).success,
    false,
  );
});

test("modal rule API refreshes immediately without upstream requests and rejects stale saves", async () => {
  const prior = process.env.DEMO_MODE,
    fetchBefore = globalThis.fetch;
  process.env.DEMO_MODE = "true";
  try {
    let s = await readState();
    s = await changeState(s.revision, (state) => {
      state.records = fixture().records;
      state.rules = [];
      state.decisions = [];
    });
    const revision = s.revision,
      records = structuredClone(s.records);
    const send = (rev: number) =>
      POST(
        new Request("http://127.0.0.1:3000/api/actions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://127.0.0.1:3000",
          },
          body: JSON.stringify({
            type: "save-vendor-exclusion",
            revision: rev,
            approve: true,
            recordId: "q",
            maxCents: null,
          }),
        }),
      );
    globalThis.fetch = async () => {
      throw Error("Rule application must not sync upstream APIs");
    };
    const response = await send(revision);
    assert.equal(response.status, 200);
    s = await response.json();
    assert.equal(s.revision, revision + 1);
    assert.equal(run(s)[0].status, "No PO required");
    assert.deepEqual(s.records, records);
    assert.ok(verifyAudit(s.audit));
    assert.equal((await send(revision)).status, 409);
    assert.deepEqual(await readState(), s);
  } finally {
    globalThis.fetch = fetchBefore;
    if (prior === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = prior;
  }
});

test("PostgreSQL preserves exact-description approval and audit results after reload", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      await readFile(new URL("../db/001_initial.sql", import.meta.url), "utf8"),
    );
    const s = fixture();
    await db.query("INSERT INTO app_state(id,payload) VALUES(1,$1)", [
      JSON.stringify(s),
    ]);
    await db.exec("BEGIN");
    const saved = await readDB(db as DB, true);
    save(saved);
    saved.revision++;
    await persistDB(db as DB, saved, 0);
    await db.exec("COMMIT");
    const loaded = await readDB(db as DB);
    assert.equal(loaded.rules[0].matchField, "description");
    assert.equal(run(loaded)[0].status, "No PO required");
    assert.deepEqual(loaded.records, s.records);
    assert.deepEqual(
      (loaded.audit.at(-1)!.detail as any).reconciliation.results,
      run(loaded),
    );
    assert.ok(verifyAudit(loaded.audit));
    await assert.rejects(db.query("DELETE FROM audit_events"), /append only/);
  } finally {
    await db.close();
  }
});
