import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichPOCustomers } from "../lib/po-customers";
import { mapST, readST } from "../lib/integrations";
import { fingerprint, reconcile } from "../lib/engine";
import { applyAction, actionSchema } from "../lib/actions";
import { filterResults, reportCSV } from "../lib/report";
import { reconciliationPDFModel } from "../lib/pdf-report-model";
import { seed } from "../lib/seed";
import { jobContext, purchaseOrderLabel } from "../lib/job-context";

const raw = {
  id: 1,
  vendorId: 7,
  number: "PO-1",
  date: "2026-09-01",
  createdOn: "2026-09-01",
  total: 100,
  status: "Sent",
  jobId: 10,
  businessUnitId: "r",
};
const po = () => mapST(raw, new Map([["7", "Vendor"]]))!;
process.env.ST_ENV = "production";
process.env.ST_TENANT_ID = "test";
process.env.ST_APP_KEY = "test";

test("PO job mapping preserves IDs and handles null or non-job POs", () => {
  assert.equal(po().jobId, "10");
  assert.equal(
    mapST({ ...raw, jobId: null }, new Map([["7", "Vendor"]]))!.jobId,
    undefined,
  );
  assert.equal(
    mapST({ ...raw, jobId: 0 }, new Map([["7", "Vendor"]]))!.jobId,
    undefined,
  );
});

test("customer enrichment batches unique referenced jobs and customers and retains only display fields", async () => {
  const records = Array.from({ length: 52 }, (_, i) => ({
    ...po(),
    id: `ST:${i}`,
    jobId: String(i + 1),
  }));
  records.push({ ...records[0], id: "duplicate-job" });
  let jobCalls = 0,
    customerCalls = 0;
  const enriched = await enrichPOCustomers(
    records,
    "token",
    async (url, init) => {
      assert.equal(init?.method, "GET");
      const u = new URL(String(url)),
        ids = u.searchParams.get("ids")!.split(",");
      assert.ok(ids.length <= 50);
      if (u.pathname.includes("/jobs")) {
        jobCalls++;
        return Response.json({
          data: ids.map((id) => ({
            id,
            customerId: "200",
            summary: "private job details",
          })),
          hasMore: false,
        });
      }
      customerCalls++;
      assert.deepEqual(ids, ["200"]);
      assert.equal(u.searchParams.get("active"), "Any");
      return Response.json({
        data: [
          { id: 200, name: "Sample Customer", address: "private address" },
        ],
        hasMore: false,
      });
    },
  );
  assert.equal(jobCalls, 2);
  assert.equal(customerCalls, 1);
  assert.ok(
    enriched.every(
      (p) => p.customerName === "Sample Customer" && p.customerId === "200",
    ),
  );
  assert.ok(enriched.every((p) => !("address" in p) && !("summary" in p)));
  assert.equal(records[0].customerName, undefined);
});

test("scoped PO import follows exact job/customer links", async () => {
  const records = await readST(
    "token",
    "2026-09-01",
    "2026-09-30",
    async (url) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("vendors"))
        return Response.json({
          data: [{ id: 7, name: "Vendor" }],
          hasMore: false,
        });
      if (u.pathname.endsWith("purchase-orders"))
        return Response.json({
          data: [raw, { ...raw, id: 2, jobId: 99, businessUnitId: "outside" }],
          hasMore: false,
        });
      if (u.pathname.endsWith("jobs")) {
        assert.equal(u.searchParams.get("ids"), "10");
        return Response.json({
          data: [{ id: 10, customerId: 20 }],
          hasMore: false,
        });
      }
      return Response.json({
        data: [{ id: 20, name: "Customer Twenty" }],
        hasMore: false,
      });
    },
    ["r"],
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].customerName, "Customer Twenty");
});

test("missing related records stay blank; bad permissions or unexpected IDs reject without mutating records", async () => {
  const records = [po()],
    before = structuredClone(records);
  assert.deepEqual(
    await enrichPOCustomers(records, "token", async () =>
      Response.json({ data: [], hasMore: false }),
    ),
    records,
  );
  await assert.rejects(
    enrichPOCustomers(
      records,
      "token",
      async () => new Response("", { status: 403 }),
    ),
    /Jobs and Customers read access/,
  );
  await assert.rejects(
    enrichPOCustomers(records, "token", async () =>
      Response.json({ data: [{ id: 999, customerId: 20 }], hasMore: false }),
    ),
    /unexpected/,
  );
  assert.deepEqual(records, before);
});

test("adding customer/job details preserves confirmations and exposes context through search, sorting and exports", () => {
  const state = seed();
  const initial = reconcile(
    state.records,
    state.config,
    state.rules,
    "2026-09-13",
  );
  const active = initial.find((r) => r.pos.includes("PO-2041"))!;
  applyAction(
    state,
    actionSchema.parse({
      type: "decision",
      revision: state.revision,
      resultId: active.id,
      action: "confirm",
    }),
    "reviewer",
  );
  const oldFingerprint = fingerprint(state.records, [
    ...active.charges,
    ...active.pos,
  ]);
  Object.assign(
    state.records.find((p) => p.id === "PO-2041")!,
    { jobId: "12345", customerId: "c1", customerName: "Example Customer" },
  );
  assert.equal(
    fingerprint(state.records, [...active.charges, ...active.pos]),
    oldFingerprint,
  );
  const results = reconcile(
    state.records,
    state.config,
    state.rules,
    "2026-09-13",
    state.decisions,
  );
  assert.equal(results.find((r) => r.id === active.id)!.status, "Confirmed");
  for (const query of ["Example Customer", "12345"])
    assert.equal(filterResults(results, state, { query })[0].id, active.id);
  for (const sortBy of ["customer", "jobId"] as const)
    for (const sortDirection of ["asc", "desc"] as const)
      assert.equal(
        filterResults(results, state, { sortBy, sortDirection })[0].id,
        active.id,
      );
  const csv = reportCSV(state, results, { query: "12345" });
  assert.match(csv, /Customer name/);
  assert.match(csv, /Example Customer/);
  assert.match(csv, /12345/);
  const model = reconciliationPDFModel(state, results, { query: "12345" });
  assert.match(model.tables[0].rows[0].at(-1)!, /Customer: Example Customer/);
  assert.match(model.tables[0].rows[0].at(-1)!, /Job ID: 12345/);
  assert.equal(
    jobContext(
      state,
      { ...active, charges: ["Q-1046", "Q-1047"] },
      "customerName",
    ),
    "Example Customer",
  );
  assert.equal(jobContext(state, { ...active, pos: [] }, "customerName"), "");
});

test("ServiceTitan visible PO and job numbers remain distinct from source IDs", async () => {
  const record = mapST(
    { ...raw, id: 321641255, number: "144860-003", jobId: 321508838 },
    new Map([["7", "2 Lowes"]]),
  )!;
  const enriched = await enrichPOCustomers([record], "token", async (url) => {
    if (String(url).includes("/jobs?"))
      return Response.json({
        data: [{ id: 321508838, jobNumber: "144860", customerId: 259964029 }],
        hasMore: false,
      });
    return Response.json({
      data: [{ id: 259964029, name: "Example Customer" }],
      hasMore: false,
    });
  });
  const state = seed();
  state.records = enriched;
  state.rules = [];
  const result = reconcile(state.records, state.config, [], "2026-09-13")[0];
  assert.equal(purchaseOrderLabel(state, result), "144860-003");
  assert.equal(jobContext(state, result, "jobNumber"), "144860");
  assert.equal(jobContext(state, result, "jobId"), "321508838");
  for (const query of ["144860-003", "321641255", "144860", "321508838"])
    assert.equal(filterResults([result], state, { query }).length, 1);
  const csv = reportCSV(state, [result], {});
  assert.match(csv, /144860-003/);
  assert.match(csv, /ST:321641255/);
  assert.equal(
    fingerprint([record], [record.id]),
    fingerprint(enriched, [record.id]),
  );
});
