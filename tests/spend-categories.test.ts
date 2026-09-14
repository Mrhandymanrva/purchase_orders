import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { parse } from "csv-parse/sync";
import { seed } from "../lib/seed";
import type { State, RecordItem, SpendCategory } from "../lib/domain";
import { actionSchema, applyAction } from "../lib/actions";
import { reconcile, fingerprint, ENGINE_VERSION } from "../lib/engine";
import {
  defaultSpendCategories,
  spendCategories,
  spendCategoryLabel,
} from "../lib/spend-categories";
import { reportCSV, filterResults } from "../lib/report";
import { reconciliationPDFModel } from "../lib/pdf-report-model";
import { scorecard } from "../lib/scorecard";
import {
  verifyAudit,
  readDB,
  persistDB,
  readState,
  changeState,
  type DB,
} from "../lib/store";
import { POST } from "../app/api/actions/route";
const record = (id: string, extra: Partial<RecordItem> = {}): RecordItem => ({
  id,
  source: "qbo",
  vendor: "Vendor not specified in QuickBooks",
  vendorMissing: true,
  description: "KREG TOOL COMPANY",
  amount: 68899,
  date: "2026-09-02",
  reference: "",
  currency: "USD",
  account: "Jason card",
  accountId: "card",
  cardUser: "Jason G.",
  ownershipSource: "Unassigned",
  ...extra,
});
function fixture() {
  const s = seed();
  s.records = [record("q"), record("other", { amount: 12000 })];
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
function categorize(s: State, id = "q", categoryId: string | null = "tools") {
  applyAction(
    s,
    actionSchema.parse({
      type: "categorize-spend",
      revision: s.revision,
      chargeId: id,
      categoryId,
    }),
    "operator",
  );
}
function manage(s: State, categories: SpendCategory[]) {
  applyAction(
    s,
    actionSchema.parse({
      type: "save-spend-categories",
      revision: s.revision,
      categories,
    }),
    "operator",
  );
}

test("legacy workspaces offer the three default choices; a category is an explicit exception for one missing-payee purchase", () => {
  const s = fixture(),
    before = structuredClone(s.records);
  assert.deepEqual(
    spendCategories(s).map((c) => c.name),
    ["Office", "Non-Billable Materials", "Tools"],
  );
  categorize(s);
  const results = run(s),
    r = results.find((r) => r.charges.includes("q"))!;
  assert.equal(r.status, "No PO required");
  assert.equal(r.categoryId, "tools");
  assert.equal(spendCategoryLabel(s, r), "Tools");
  assert.equal(r.score, 0);
  assert.deepEqual(r.pos, []);
  assert.equal(
    results.find((r) => r.charges.includes("other"))!.status,
    "Payee not assigned",
  );
  assert.deepEqual(s.records, before);
  assert.deepEqual(s.rules, []);
  assert.equal(s.decisions[0].action, "categorize");
  assert.equal(s.audit.at(-1)!.action, "Spend categorized");
  assert.equal(
    (s.audit.at(-1)!.detail as any).reconciliation.engine,
    ENGINE_VERSION,
  );
  assert.ok(verifyAudit(s.audit));
});

test("categories can be added, renamed and archived while saved labels and historical audit evidence survive", () => {
  const s = fixture();
  categorize(s);
  const snapshot = structuredClone(s.decisions);
  manage(s, [
    ...spendCategories(s).map((c) =>
      c.id === "tools" ? { ...c, name: "Equipment", active: false } : c,
    ),
    { id: "training", name: " Training  Supplies ", active: true },
  ]);
  assert.equal(spendCategories(s).at(-1)!.name, "Training Supplies");
  assert.equal(
    spendCategoryLabel(
      s,
      run(s).find((r) => r.charges.includes("q"))!,
    ),
    "Equipment",
  );
  assert.equal(
    run(s).find((r) => r.charges.includes("q"))!.status,
    "No PO required",
  );
  assert.deepEqual(s.decisions, snapshot);
  assert.equal(s.decisions[0].categoryName, "Tools");
  const before = structuredClone(s);
  assert.throws(
    () => categorize(s, "other", "tools"),
    /available spend category/,
  );
  assert.deepEqual(s, before);
  categorize(s, "q", "training");
  assert.equal(
    spendCategoryLabel(
      s,
      run(s).find((r) => r.charges.includes("q"))!,
    ),
    "Training Supplies",
  );
  assert.ok(verifyAudit(s.audit));
});

test("category management rejects duplicate or blank choices and removal of stable IDs without changing state", () => {
  const s = fixture(),
    before = structuredClone(s),
    defaults = structuredClone(defaultSpendCategories);
  for (const list of [
    defaults.slice(1),
    [...defaults, { id: "tools", name: "Other", active: true }],
    [...defaults, { id: "another", name: "TOOLS", active: true }],
    [...defaults, { id: "blank", name: "  ", active: true }],
  ])
    assert.throws(() => manage(s, list));
  assert.deepEqual(s, before);
  assert.equal(
    actionSchema.safeParse({
      type: "categorize-spend",
      revision: 1,
      chargeId: "q",
    }).success,
    false,
  );
  assert.throws(() => categorize(s, "missing"), /no longer exists/);
  assert.throws(() => categorize(s, "q", "unknown"), /available/);
  assert.deepEqual(s, before);
});

test("clearing returns a purchase to ordinary matching; another purchase and its saved decision remain unchanged", () => {
  const s = fixture();
  categorize(s);
  categorize(s, "other", "office");
  const other = structuredClone(
    s.decisions.find((d) => d.charges.includes("other")),
  );
  categorize(s, "q", null);
  assert.equal(
    run(s).find((r) => r.charges.includes("q"))!.status,
    "Payee not assigned",
  );
  assert.deepEqual(s.decisions, [other]);
  assert.equal(
    spendCategoryLabel(
      s,
      run(s).find((r) => r.charges.includes("other"))!,
    ),
    "Office",
  );
  assert.ok(verifyAudit(s.audit));
});

test("an explicit individual classification can replace a linked review while releasing its PO and keeping 1:1 allocation", () => {
  const s = fixture();
  s.records = [
    record("q", { vendor: "Kreg", vendorMissing: false }),
    record("p", { source: "st", vendor: "Kreg", vendorMissing: false }),
    record("other", { vendor: "Elsewhere", vendorMissing: false }),
  ];
  const initial = run(s).find((r) => r.charges.includes("q"))!;
  applyAction(
    s,
    {
      type: "decision",
      revision: s.revision,
      resultId: initial.id,
      action: "confirm",
      reason: "",
      poIds: ["p"],
    },
    "operator",
  );
  const records = structuredClone(s.records);
  categorize(s);
  const r = run(s).find((r) => r.charges.includes("q"))!;
  assert.deepEqual(r.pos, []);
  assert.equal(r.status, "No PO required");
  assert.ok(run(s).some((r) => r.pos.includes("p")));
  assert.deepEqual(s.records, records);
  const allocated = run(s).flatMap((r) => [...r.charges, ...r.pos]);
  assert.equal(new Set(allocated).size, 3);
  assert.equal(allocated.length, 3);
  assert.equal((s.audit.at(-1)!.detail as any).before[0].action, "confirm");
});

test("a category survives unchanged imports and invalidates on changed financial or ownership evidence", () => {
  const s = fixture();
  categorize(s);
  const records = structuredClone(s.records);
  applyAction(s, { type: "sync", revision: s.revision }, "operator", records);
  assert.equal(
    run(s).find((r) => r.charges.includes("q"))!.categoryId,
    "tools",
  );
  const changed = structuredClone(records);
  changed[0].amount++;
  applyAction(s, { type: "sync", revision: s.revision }, "operator", changed);
  assert.equal(
    run(s).find((r) => r.charges.includes("q"))!.categoryId,
    undefined,
  );
  assert.equal(s.decisions[0].categoryId, "tools");
  categorize(s);
  assert.equal(
    run(s).find((r) => r.charges.includes("q"))!.categoryId,
    "tools",
  );
  s.records[0].cardUser = "Another user";
  assert.equal(
    run(s).find((r) => r.charges.includes("q"))!.categoryId,
    undefined,
  );
});

test("category does not exempt peer duplicates or refunds automatically; explicit refund classification preserves signed totals", () => {
  const s = fixture();
  s.records = [
    record("q"),
    record("duplicate"),
    record("refund", { amount: -5037 }),
  ];
  categorize(s);
  const results = run(s);
  assert.equal(
    results.find((r) => r.charges.includes("duplicate"))!.status,
    "Possible duplicate",
  );
  assert.equal(
    results.find((r) => r.charges.includes("refund"))!.status,
    "Payee not assigned",
  );
  categorize(s, "refund", "tools");
  assert.equal(run(s).find((r) => r.charges.includes("refund"))!.amount, -5037);
  assert.equal(
    scorecard(s, run(s), { from: "2026-09-01", to: "2026-09-30" }).total.spend,
    132761,
  );
});

test("CSV, PDF, search and category sorting use current category names without changing amounts", () => {
  const s = fixture();
  s.records.push(record("uncategorized", { amount: 1500 }));
  categorize(s);
  categorize(s, "other", "office");
  const results = run(s);
  assert.deepEqual(
    filterResults(results, s, { sortBy: "category", sortDirection: "asc" }).map(
      (r) => r.charges[0],
    ),
    ["other", "q", "uncategorized"],
  );
  assert.deepEqual(
    filterResults(results, s, {
      sortBy: "category",
      sortDirection: "desc",
    }).map((r) => r.charges[0]),
    ["q", "other", "uncategorized"],
  );
  assert.deepEqual(
    filterResults(results, s, { query: "Tools" }).map((r) => r.charges[0]),
    ["q"],
  );
  const csv = parse(reportCSV(s, results, {}), {
    columns: true,
    bom: true,
  }) as Record<string, string>[];
  assert.equal(
    csv.find((r) => r["Charge ID"] === "q")!["Spend category"],
    "Tools",
  );
  const pdf = reconciliationPDFModel(s, results, { query: "Tools" });
  assert.equal(pdf.metrics[0].value, "$688.99");
  assert.match(pdf.tables[0].rows[0][5], /Category: Tools/);
  assert.equal(pdf.metrics[2].value, "0");
  assert.equal(
    scorecard(s, results, { from: "2026-09-01", to: "2026-09-30" }).total.spend,
    82399,
  );
});

test("category API saves and refreshes without upstream requests, rejects stale revisions and keeps invalid saves atomic", async () => {
  const previous = process.env.DEMO_MODE,
    originalFetch = globalThis.fetch;
  process.env.DEMO_MODE = "true";
  try {
    let s = await readState();
    s = await changeState(s.revision, (state) => {
      state.records = fixture().records;
      state.rules = [];
      state.decisions = [];
      delete state.spendCategories;
    });
    const send = (revision: number, categoryId = "tools") =>
      POST(
        new Request("http://127.0.0.1:3000/api/actions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://127.0.0.1:3000",
          },
          body: JSON.stringify({
            type: "categorize-spend",
            revision,
            chargeId: "q",
            categoryId,
          }),
        }),
      );
    globalThis.fetch = async () => {
      throw Error("No upstream calls expected");
    };
    const res = await send(s.revision);
    assert.equal(res.status, 200);
    const saved: State = await res.json();
    assert.equal(
      run(saved).find((r) => r.charges.includes("q"))!.status,
      "No PO required",
    );
    assert.equal(saved.revision, s.revision + 1);
    assert.equal((await send(s.revision)).status, 409);
    assert.equal((await send(saved.revision, "invalid")).status, 400);
    assert.deepEqual(await readState(), saved);
    assert.ok(verifyAudit(saved.audit));
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = previous;
  }
});

test("PostgreSQL roundtrip retains categories, the approved classification and immutable audit", async () => {
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
    manage(saved, [
      ...spendCategories(saved),
      { id: "equipment", name: "Equipment", active: true },
    ]);
    categorize(saved, "q", "equipment");
    saved.revision++;
    await persistDB(db as DB, saved, 0);
    await db.exec("COMMIT");
    const loaded = await readDB(db as DB);
    assert.equal(
      spendCategoryLabel(
        loaded,
        run(loaded).find((r) => r.charges.includes("q"))!,
      ),
      "Equipment",
    );
    assert.deepEqual(loaded.records, s.records);
    assert.ok(verifyAudit(loaded.audit));
    await assert.rejects(db.query("DELETE FROM audit_events"), /append only/);
  } finally {
    await db.close();
  }
});
