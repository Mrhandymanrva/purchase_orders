import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "csv-parse/sync";
import { seed } from "../lib/seed";
import { type State, type Result, type RecordItem } from "../lib/domain";
import {
  filterResults,
  reportAmount,
  reportCSV,
  nextReportSort,
  type ReportSort,
} from "../lib/report";
import { reconciliationPDFModel } from "../lib/pdf-report-model";
import { GET } from "../app/api/report/route";
import { readState } from "../lib/store";
import { reconcile } from "../lib/engine";
function fixture() {
  const state = seed();
  state.rules = [];
  state.decisions = [];
  const data = [
    ["q1", "Zulu", "Bob", 10000, "2026-01-02", 90, "ST:10", "Matched"],
    ["q2", "alpha", "Alice", -5037, "2025-12-31", 85, "ST:2", "Matched"],
    ["q3", "Beta", "Carl", 900, "2026-02-01", 0, "", "Missing PO"],
    [
      "q4",
      "alpha",
      "Daniel",
      900,
      "2026-01-03",
      89,
      "ST:30",
      "Matched with flags",
    ],
  ] as const;
  state.records = data.map(
    ([id, vendor, cardUser, amount, date]): RecordItem => ({
      id,
      vendor,
      cardUser,
      amount,
      date,
      source: "qbo",
      account: id,
      description: "",
      reference: "",
      currency: "USD",
    }),
  );
  const results: Result[] = data.map(
    ([id, vendor, , amount, date, score, po, status]) => ({
      id,
      vendor,
      amount,
      date,
      score,
      pos: po ? [po] : [],
      charges: [id],
      status,
      reasons: [],
      flags: [],
      difference: 0,
      kind: "1:1",
    }),
  );
  for (const r of results)
    if (r.pos.length)
      state.records.push({
        ...state.records.find((q) => q.id === r.id)!,
        id: r.pos[0],
        source: "st",
        cardUser: undefined,
      });
  return { state, results };
}
test("headers sort visible text, dates, signed amounts and numeric references in both directions; missing values stay last", () => {
  const { state, results } = fixture(),
    snapshot = structuredClone(results);
  const cases: [ReportSort["sortBy"], string[], string[]][] = [
    ["vendor", ["q2", "q4", "q3", "q1"], ["q1", "q3", "q2", "q4"]],
    ["cardUser", ["q2", "q1", "q3", "q4"], ["q4", "q3", "q1", "q2"]],
    ["date", ["q2", "q1", "q4", "q3"], ["q3", "q4", "q1", "q2"]],
    ["amount", ["q2", "q3", "q4", "q1"], ["q1", "q3", "q4", "q2"]],
    ["status", ["q1", "q2", "q4", "q3"], ["q3", "q4", "q1", "q2"]],
    ["score", ["q2", "q4", "q1", "q3"], ["q1", "q4", "q2", "q3"]],
    ["po", ["q2", "q1", "q4", "q3"], ["q4", "q1", "q2", "q3"]],
  ];
  for (const [sortBy, asc, desc] of cases)
    for (const [sortDirection, expected] of [
      ["asc", asc],
      ["desc", desc],
    ] as const) {
      const filter = { sortBy, sortDirection };
      assert.deepEqual(
        filterResults(results, state, filter).map((r) => r.id),
        expected,
        sortBy + " " + sortDirection,
      );
      assert.deepEqual(
        filterResults(results.slice().reverse(), state, filter).map(
          (r) => r.id,
        ),
        expected,
        "stable ties",
      );
    }
  assert.deepEqual(results, snapshot);
  assert.deepEqual(
    filterResults(results, state, {}).map((r) => r.id),
    cases[2][2],
  );
});
test("sort toggles and filtered group amounts agree with the register without changing matching results", () => {
  let sort: ReportSort = { sortBy: "date", sortDirection: "desc" };
  sort = nextReportSort(sort, "amount");
  assert.equal(sort.sortDirection, "desc");
  sort = nextReportSort(sort, "amount");
  assert.equal(sort.sortDirection, "asc");
  sort = nextReportSort(sort, "vendor");
  assert.equal(sort.sortDirection, "asc");
  sort = nextReportSort(sort, "vendor");
  assert.equal(sort.sortDirection, "desc");
  const { state, results } = fixture();
  state.records.find((q) => q.id === "q1")!.cardUser = "Alice";
  results[0].charges.push("shared");
  results[0].amount = 100100;
  state.records.push({
    ...state.records[0],
    id: "shared",
    cardUser: "Bob",
    amount: 90100,
    date: "2026-02-01",
  });
  const individual = {
    individual: "Alice",
    sortBy: "amount" as const,
    sortDirection: "asc" as const,
  };
  assert.equal(reportAmount(state, results[0], individual), 10000);
  assert.equal(reportAmount(state, results[0], { to: "2026-01-31" }), 10000);
  assert.equal(reportAmount(state, results[0], {}), 100100);
  assert.deepEqual(
    filterResults(results, state, individual).map((r) => r.id),
    ["q2", "q1"],
  );
  const { state: original, results: originalResults } = fixture();
  const sorted = filterResults(originalResults, original, {
    status: "Matched",
    sortBy: "amount",
    sortDirection: "desc",
  });
  assert.deepEqual(
    sorted.map((r) => r.id),
    ["q1", "q4", "q2"],
  );
});
test("CSV and PDF preserve the selected register group order and existing totals", () => {
  const { state, results } = fixture();
  const filter = { sortBy: "po" as const, sortDirection: "asc" as const };
  const ordered = filterResults(results, state, filter);
  const csv = parse<Record<string, string>>(reportCSV(state, results, filter), {
    bom: true,
    columns: true,
  });
  assert.deepEqual(
    csv.map((r) => r["Charge ID"]),
    ordered.map((r) => r.id),
  );
  const pdf = reconciliationPDFModel(state, results, filter);
  assert.deepEqual(
    pdf.tables[0].rows.map((r) => r[1].split("\n")[1]),
    ordered.map((r) => r.id),
  );
  assert.deepEqual(
    pdf.metrics,
    reconciliationPDFModel(state, results, {}).metrics,
  );
});
test("report API validates sorting and exports the selected order without changing workspace state", async () => {
  const previous = process.env.DEMO_MODE;
  process.env.DEMO_MODE = "true";
  try {
    const before = await readState(),
      results = reconcile(
        before.records,
        before.config,
        before.rules,
        "2026-09-13",
        before.decisions,
        before.coverage,
      );
    const request = (query: string) =>
      GET(new Request("http://127.0.0.1:3000/api/report?" + query));
    for (const bad of [
      "sortBy=unknown",
      "sortDirection=sideways",
      "sortBy=__proto__&format=pdf",
    ])
      assert.equal((await request(bad)).status, 400);
    const response = await request("sortBy=amount&sortDirection=asc");
    assert.equal(response.status, 200);
    const csv = parse<Record<string, string>>(await response.text(), {
      bom: true,
      columns: true,
    });
    const expected = filterResults(results, before, {
      sortBy: "amount",
      sortDirection: "asc",
    }).flatMap((r) => (r.charges.length ? r.charges : [""]));
    assert.deepEqual(
      csv.map((r) => r["Charge ID"]),
      expected,
    );
    const pdf = await request("sortBy=vendor&sortDirection=desc&format=pdf");
    assert.equal(pdf.status, 200);
    assert.equal(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 5)
        .toString(),
      "%PDF-",
    );
    assert.deepEqual(await readState(), before);
  } finally {
    if (previous === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = previous;
  }
});
