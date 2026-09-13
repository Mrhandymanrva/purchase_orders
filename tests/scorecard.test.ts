import { test } from "node:test";
import assert from "node:assert/strict";
import {
  periodRange,
  periodContaining,
  weeksInYear,
  scorecard,
  scorecardCSV,
} from "../lib/scorecard";
import { seed } from "../lib/seed";
import { reconcile } from "../lib/engine";
import { applyAction } from "../lib/actions";
import { resolvePerson } from "../lib/directory";
import { mapST, readDirectories, readQBAccounts } from "../lib/integrations";
import { planMappingImport } from "../lib/card-import";
import { classifyVanStock, VAN_STOCK_RULE } from "../lib/van-stock";
import type { RecordItem, Result } from "../lib/domain";
const range = { from: "2026-09-01", to: "2026-09-30" };
const record = (
  id: string,
  source: "qbo" | "st",
  amount: number,
  extra: Partial<RecordItem> = {},
): RecordItem => ({
  id,
  source,
  amount,
  date: "2026-09-10",
  vendor: "Vendor",
  reference: "",
  account: "",
  description: "",
  currency: "USD",
  ...extra,
});
const link = (
  pos: string[],
  charges: string[],
  status = "Matched",
): Result => ({
  id: "group",
  pos,
  charges,
  status,
  date: "2026-09-10",
  vendor: "Vendor",
  amount: 0,
  difference: 0,
  score: 90,
  reasons: [],
  flags: [],
  kind: "1:1",
});
test("periods include leap days, quarter/year boundaries and ISO weeks across years", () => {
  assert.deepEqual(periodContaining("2027-01-01", "week"), {
    unit: "week",
    year: 2026,
    period: 53,
  });
  assert.deepEqual(periodContaining("2026-09-13", "quarter"), {
    unit: "quarter",
    year: 2026,
    period: 3,
  });
  assert.deepEqual(periodRange({ unit: "month", year: 2024, period: 2 }), {
    from: "2024-02-01",
    to: "2024-02-29",
  });
  assert.deepEqual(periodRange({ unit: "quarter", year: 2026, period: 4 }), {
    from: "2026-10-01",
    to: "2026-12-31",
  });
  assert.deepEqual(periodRange({ unit: "year", year: 2026, period: 1 }), {
    from: "2026-01-01",
    to: "2026-12-31",
  });
  assert.deepEqual(periodRange({ unit: "week", year: 2026, period: 1 }), {
    from: "2025-12-29",
    to: "2026-01-04",
  });
  assert.equal(weeksInYear(2026), 53);
  assert.equal(weeksInYear(2025), 52);
  assert.throws(() => periodRange({ unit: "week", year: 2025, period: 53 }));
  assert.throws(() => periodRange({ unit: "month", year: 2026, period: 13 }));
});
test("technician totals conserve all source dollars; Van Stock is a PO subset and includes uncharged POs", () => {
  const s = seed(),
    results = reconcile(s.records, s.config, s.rules, "2026-09-13"),
    data = scorecard(s, results, range);
  assert.equal(
    data.total.spend,
    s.records
      .filter((r) => r.source === "qbo")
      .reduce((a, r) => a + r.amount, 0),
  );
  assert.equal(
    data.total.poTotal,
    s.records
      .filter((r) => r.source === "st")
      .reduce((a, r) => a + r.amount, 0),
  );
  assert.equal(data.total.vanStock, 62500 + 28999);
  assert.equal(data.total.vanStockCount, 2);
  assert.equal(
    data.rows.find((r) => r.id === "technician:demo-3")!.vanStock,
    91499,
  );
  assert.ok(
    data.evidence.some(
      (e) => e.record.id === "PO-2051" && e.basis.startsWith("ServiceTitan"),
    ),
  );
});
test("POs use their own date and an accepted card owner even when its charge is in another period", () => {
  const s = seed();
  s.records = [
    record("q", "qbo", 10000, { cardUser: "Alex Morgan", date: "2026-10-01" }),
    record("p", "st", 10000, { technicianId: "demo-2" }),
  ];
  const data = scorecard(s, [link(["p"], ["q"])], range);
  assert.equal(data.total.spend, 0);
  assert.equal(
    data.rows.find((r) => r.id === "technician:demo-1")!.poTotal,
    10000,
  );
  assert.equal(data.rows.find((r) => r.id === "technician:demo-2")!.poTotal, 0);
  const proposed = scorecard(s, [link(["p"], ["q"], "Needs review")], range);
  assert.equal(
    proposed.rows.find((r) => r.id === "technician:demo-2")!.poTotal,
    10000,
  );
});
test("shared PO counts once, split payments do not duplicate POs, and refunds reduce totals", () => {
  const s = seed();
  s.records = [
    record("q1", "qbo", 7000, { cardUser: "Alex Morgan" }),
    record("q2", "qbo", 3000, { cardUser: "Chris Parker" }),
    record("p", "st", 10000),
    record("credit", "qbo", -1000, { cardUser: "Alex Morgan" }),
    record("return", "st", -1000, {
      technicianId: "demo-1",
      poTypeId: "demo-van-stock",
    }),
  ];
  const data = scorecard(s, [link(["p"], ["q1", "q2"])], range);
  assert.equal(data.rows.find((r) => r.id === "shared")!.poTotal, 10000);
  assert.equal(data.total.poTotal, 9000);
  assert.equal(data.total.spend, 9000);
  assert.equal(data.total.vanStock, -1000);
  s.records[1].cardUser = "Alex Morgan";
  const one = scorecard(s, [link(["p"], ["q1", "q2"])], range);
  assert.equal(one.rows.find((r) => r.id === "technician:demo-1")!.poCount, 2);
  assert.equal(one.total.poCount, 2);
});
test("empty periods stay zero; explicit ST labels work without additional configuration", () => {
  const s = seed();
  delete s.vanStockTypeIds;
  const data = scorecard(s, [], { from: "2025-01-01", to: "2025-12-31" });
  assert.equal(data.total.spend, 0);
  assert.equal(data.total.poTotal, 0);
  assert.equal(data.vanStockConfigured, true);
  assert.ok(scorecardCSV(data, range).includes(VAN_STOCK_RULE));
  assert.equal(scorecard(s, [], range).total.vanStock, 91499);
});
test("Van Stock classification accepts explicit labels and audited additional type IDs", () => {
  const s = seed();
  s.records = [
    record("p1", "st", 100, {
      description: "Job supplies, not Van Stock",
      poTypeId: "demo-job",
    }),
    record("p2", "st", 200, { poTypeId: "demo-van-stock" }),
    record("p3", "st", 300),
  ];
  const data = scorecard(s, [], range);
  assert.equal(data.total.vanStock, 200);
  assert.equal(data.total.unknownPoTypeCount, 1);
  assert.throws(() =>
    applyAction(
      s,
      {
        type: "scorecard-settings",
        revision: s.revision,
        vanStockTypeIds: ["unknown"],
        reason: "Verified types",
      },
      "operator",
    ),
  );
  applyAction(
    s,
    {
      type: "scorecard-settings",
      revision: s.revision,
      vanStockTypeIds: ["demo-job"],
      reason: "Verified types",
    },
    "operator",
  );
  assert.equal(scorecard(s, [], range).total.vanStock, 300);
  assert.equal(s.audit.at(-1)?.action, "Van Stock scorecard types saved");
});
test("VAN STOCK and VS source labels are case-insensitive, whole leading labels with source evidence", () => {
  const s = seed();
  delete s.vanStockTypeIds;
  for (const label of [
    "VAN STOCK",
    "vs",
    " Van   Stock: supplies",
    "[VS] restock",
    "VS-1044",
    "VAN STOCK / truck 3",
  ]) {
    for (const field of ["reference", "description"] as const) {
      const data = classifyVanStock(
        record("p", "st", 100, { [field]: label }),
        s,
      );
      assert.equal(data.vanStock, true, `${field}: ${label}`);
      assert.match(data.basis, field === "reference" ? /number/ : /summary/);
      assert.equal(data.unknownType, false);
      assert.equal(data.rule, VAN_STOCK_RULE);
    }
  }
  for (const label of [
    "VS123",
    "VStock",
    "Van stockroom",
    "Supplies vs labor",
    "Not VAN STOCK",
    "Job supplies [VS]",
  ]) {
    assert.equal(
      classifyVanStock(record("p", "st", 100, { description: label }), s)
        .vanStock,
      false,
      label,
    );
  }
  assert.equal(
    classifyVanStock(
      record("q", "qbo", 100, { description: "VS: supplies" }),
      s,
    ).vanStock,
    false,
  );
});

test("exact ST type aliases are recognized but similar type names require approval", () => {
  const s = seed();
  delete s.vanStockTypeIds;
  s.directory!.poTypes = [
    { id: "alias", name: " vs ", active: false },
    { id: "similar", name: "Van Stockroom", active: true },
  ];
  assert.equal(
    classifyVanStock(record("p", "st", 100, { poTypeId: "alias" }), s).vanStock,
    true,
  );
  assert.equal(
    classifyVanStock(record("p", "st", 100, { poTypeId: "similar" }), s)
      .vanStock,
    false,
  );
  assert.equal(
    classifyVanStock(record("p", "st", 100, { poTypeId: "missing" }), s)
      .unknownType,
    true,
  );
});

test("ST summary labels survive adapter import and credits/dates/owners use the same scorecard rules", () => {
  const s = seed();
  delete s.vanStockTypeIds;
  const imported = (
    id: number,
    summary: string,
    total: number,
    date = "2026-09-10",
  ) =>
    mapST(
      {
        id,
        vendorId: 1,
        number: `PO-${id}`,
        date,
        createdOn: date + "T12:00:00Z",
        total,
        status: "Sent",
        summary,
        technicianId: "demo-3",
      },
      new Map([["1", "Vendor"]]),
    )!;
  s.records = [
    imported(1, "VAN STOCK: restock", 100),
    imported(2, "VS: return", -25),
    imported(3, "VS: old stock", 50, "2026-08-31"),
  ];
  const data = scorecard(s, [], range);
  assert.equal(data.total.vanStock, 7500);
  assert.equal(data.total.vanStockCount, 2);
  assert.equal(data.total.unknownPoTypeCount, 0);
  assert.equal(
    data.rows.find((r) => r.id === "technician:demo-3")!.vanStock,
    7500,
  );
  assert.ok(
    data.evidence.every((e) => e.vanStockBasis === "ServiceTitan PO summary"),
  );
  assert.equal(s.records[0].description, "VAN STOCK: restock");
});

test("stable ST IDs separate duplicate names and directory-based edits invalidate ownership evidence", () => {
  const s = seed();
  s.directory!.people.push({
    id: "technician:other",
    sourceId: "other",
    name: "Alex Morgan",
    kind: "technician",
    active: true,
  });
  assert.throws(() => resolvePerson(s, "Alex Morgan"), /ambiguous/);
  assert.equal(
    resolvePerson(s, "Alex Morgan", "technician:other").personId,
    "technician:other",
  );
  assert.throws(
    () => resolvePerson(s, "Chris Parker", "technician:other"),
    /disagree/,
  );
  applyAction(
    s,
    {
      type: "save-card-mapping",
      revision: s.revision,
      mapping: {
        accountId: "demo-81",
        personId: "technician:other",
        cardUser: "Alex Morgan",
        reason: "Verified duplicate name",
      },
    },
    "operator",
  );
  const results = reconcile(s.records, s.config, s.rules, "2026-09-13");
  const r = results.find((r) => r.charges.includes("Q-1041"))!;
  applyAction(
    s,
    {
      type: "decision",
      revision: s.revision,
      resultId: r.id,
      action: "confirm",
      reason: "Verified receipt",
    },
    "operator",
  );
  assert.equal(
    reconcile(s.records, s.config, s.rules, "2026-09-13", s.decisions).find(
      (v) => v.id === r.id,
    )?.status,
    "Confirmed",
  );
  const mapping = s.cardMappings![0];
  applyAction(
    s,
    {
      type: "save-card-mapping",
      revision: s.revision,
      mapping: { ...mapping, personId: "technician:demo-1" },
    },
    "operator",
  );
  assert.notEqual(
    reconcile(s.records, s.config, s.rules, "2026-09-13", s.decisions).find(
      (v) => v.id === r.id,
    )?.status,
    "Confirmed",
  );
  assert.equal(
    s.records.find((v) => v.id === "Q-1041")?.cardPersonId,
    "technician:demo-1",
  );
});
test("subaccounts without transactions can be mapped from the QBO directory; spreadsheet IDs preserve identity", () => {
  const s = seed();
  s.directory!.accounts.push({
    id: "new-card",
    name: "Main CC: Newly issued",
    active: true,
  });
  applyAction(
    s,
    {
      type: "save-card-mapping",
      revision: s.revision,
      mapping: {
        accountId: "new-card",
        personId: "technician:demo-1",
        cardUser: "Alex Morgan",
        reason: "Newly issued card",
      },
    },
    "operator",
  );
  const mapping = s.cardMappings![0];
  const plan = planMappingImport(
    s,
    [{ ...mapping, row: 2 }],
    "Roster reupload",
  );
  assert.equal(plan.counts.unchanged, 1);
  assert.equal(plan.mappings[0].personId, "technician:demo-1");
  const conflict = planMappingImport(
    s,
    [{ ...mapping, row: 2, cardUser: "Chris Parker" }],
    "Roster correction",
  );
  assert.ok(conflict.errors.some((e) => e.message.includes("disagree")));
});
test("ST adapter preserves explicit technician, PO type and inventory location IDs", () => {
  const p = mapST(
    {
      id: 1,
      vendorId: 2,
      number: "PO1",
      date: "2026-09-01",
      createdOn: "2026-09-01",
      total: 12.34,
      status: "Sent",
      technicianId: 123,
      typeId: 456,
      inventoryLocationId: 789,
    },
    new Map([["2", "Vendor"]]),
  )!;
  assert.equal(p.technicianId, "123");
  assert.equal(p.poTypeId, "456");
  assert.equal(p.inventoryLocationId, "789");
});
test("dropdown adapters use GET, filter QB descendants and retain only required employee metadata", async () => {
  const env = {
    ST_TENANT_ID: process.env.ST_TENANT_ID,
    ST_APP_KEY: process.env.ST_APP_KEY,
    QBO_PARENT_CC_ACCOUNT_ID: process.env.QBO_PARENT_CC_ACCOUNT_ID,
    QBO_CARD_ACCOUNT_IDS: process.env.QBO_CARD_ACCOUNT_IDS,
  };
  Object.assign(process.env, {
    ST_TENANT_ID: "tenant",
    ST_APP_KEY: "test-key",
    QBO_PARENT_CC_ACCOUNT_ID: "main",
    QBO_CARD_ACCOUNT_IDS: "child",
  });
  try {
    const mock: typeof fetch = async (url, init) => {
      assert.equal(init?.method, "GET");
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/query"))
        return Response.json({
          QueryResponse: {
            Account: [
              {
                Id: "main",
                Name: "Main",
                AccountType: "Credit Card",
                Active: true,
              },
              {
                Id: "child",
                Name: "Card",
                FullyQualifiedName: "Main: Card",
                AccountType: "Credit Card",
                Active: true,
                SubAccount: true,
                ParentRef: { value: "main" },
              },
              {
                Id: "nested",
                Name: "Nested",
                AccountType: "Credit Card",
                Active: false,
                SubAccount: true,
                ParentRef: { value: "child" },
              },
              {
                Id: "outside",
                Name: "Outside",
                AccountType: "Credit Card",
                Active: true,
                SubAccount: true,
                ParentRef: { value: "different" },
              },
            ],
          },
        });
      return Response.json({
        hasMore: false,
        data: [
          {
            id: 1,
            name: path.endsWith("/purchase-order-types") ? "Van Stock" : "Alex",
            active: true,
            email: "private@example.com",
            hourlyRate: 50,
          },
        ],
      });
    };
    const directory = await readDirectories("st", "qb", "realm", mock);
    assert.deepEqual(
      directory.accounts.map((a) => a.id),
      ["child", "nested"],
    );
    assert.equal(directory.people.length, 2);
    assert.notEqual(directory.people[0].id, directory.people[1].id);
    assert.equal((directory.people[0] as any).email, undefined);
    assert.equal(directory.poTypes[0].name, "Van Stock");
    await assert.rejects(
      readQBAccounts(
        "token",
        "realm",
        async () => new Response("", { status: 403 }),
      ),
      /403/,
    );
  } finally {
    for (const [key, value] of Object.entries(env))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
