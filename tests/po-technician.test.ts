import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "csv-parse/sync";
import { seed } from "../lib/seed";
import { reconcile } from "../lib/engine";
import type { RecordItem, Result } from "../lib/domain";
import {
  poTechnician,
  poTechnicianLabel,
  reconciliationIndividuals,
} from "../lib/po-technician";
import {
  filterResults,
  reportCSV,
  chargeInReport,
  reportAmount,
  nextReportSort,
} from "../lib/report";
import { reconciliationPDFModel } from "../lib/pdf-report-model";
import { GET } from "../app/api/report/route";

function fixture() {
  const state = seed();
  state.rules = [];
  state.decisions = [];
  const row = (
    id: string,
    source: "qbo" | "st",
    amount: number,
    extra: Partial<RecordItem> = {},
  ): RecordItem => ({
    id,
    source,
    amount,
    vendor: id,
    date: "2026-09-01",
    currency: "USD",
    reference: "",
    description: "",
    account: "",
    ...extra,
  });
  state.records = [
    row("q-alex", "qbo", 10000, {
      vendor: "Supply",
      cardUser: "Alex card label",
      cardPersonId: "technician:demo-1",
    }),
    row("p-taylor", "st", 10000, { vendor: "Supply", technicianId: "demo-3" }),
    row("p-alex", "st", 3000, { technicianId: "demo-1" }),
    row("p-chris", "st", 4000, { technicianId: "demo-2" }),
    row("q-only", "qbo", 900, { cardUser: "Chris Parker" }),
  ];
  const results = reconcile(
    state.records,
    { ...state.config, automationMode: "match-and-flag" },
    [],
    "2026-09-14",
  );
  return { state, results };
}

test("PO technician uses the source ST identity even when the card user differs", () => {
  const { state, results } = fixture();
  const linked = results.find((r) => r.charges.includes("q-alex"))!;
  assert.equal(poTechnicianLabel(state, linked), "Taylor Reed");
  assert.equal(
    state.records.find((r) => r.id === "q-alex")!.cardUser,
    "Alex card label",
  );
  assert.equal(
    poTechnicianLabel(
      state,
      results.find((r) => r.pos.includes("p-alex"))!,
    ),
    "Alex Morgan",
  );
  assert.equal(
    poTechnicianLabel(
      state,
      results.find((r) => r.charges.includes("q-only"))!,
    ),
    "—",
  );
});

test("missing and historical technician names remain explicit and never use an employee with the same numeric ID", () => {
  const { state } = fixture(),
    po = state.records.find((r) => r.id === "p-alex")!;
  po.technicianId = "missing";
  state.directory!.people.push({
    id: "employee:missing",
    sourceId: "missing",
    name: "Different office employee",
    kind: "employee",
    active: true,
  });
  assert.equal(poTechnician(state, po).name, "ST technician #missing");
  state.cardMappings = [
    {
      id: "m",
      accountId: "a",
      personId: "technician:missing",
      cardUser: "Former technician",
      reason: "",
    },
  ];
  assert.equal(poTechnician(state, po).name, "Former technician");
  assert.match(poTechnician(state, po).basis, /Saved/);
  state.cardMappings.push({
    id: "m2",
    accountId: "b",
    personId: "technician:missing",
    cardUser: "Conflicting name",
    reason: "",
  });
  assert.equal(poTechnician(state, po).name, "ST technician #missing");
  po.technicianId = undefined;
  assert.equal(poTechnician(state, po).name, "Technician not specified");
});

test("individual filter includes unlinked POs and resolves card-name aliases through verified ST identity without reallocating another user's spend", () => {
  const { state, results } = fixture();
  const selected = filterResults(results, state, { individual: "Alex Morgan" });
  assert.equal(selected.length, 2);
  assert.ok(selected.some((r) => r.charges.includes("q-alex")));
  assert.ok(selected.some((r) => r.pos.includes("p-alex")));
  assert.deepEqual(
    filterResults(results, state, { individual: "Alex card label" }),
    selected,
  );
  const q = state.records.find((r) => r.id === "q-alex")!;
  assert.equal(chargeInReport(q, { individual: "Alex Morgan" }, state), true);
  assert.equal(chargeInReport(q, { individual: "Taylor Reed" }, state), false);
  assert.equal(
    filterResults(results, state, { individual: "Taylor Reed" }).length,
    0,
  );
  assert.equal(
    filterResults(results, state, {
      individual: "Alex Morgan",
      from: "2026-09-02",
    }).length,
    0,
  );
  assert.ok(reconciliationIndividuals(state).includes("Alex Morgan"));
  assert.equal(
    filterResults(results, state, { query: "Taylor Reed" }).length,
    1,
  );
  assert.equal(
    reportAmount(
      state,
      selected.find((r) => r.charges.length)!,
      { individual: "Alex Morgan" },
    ),
    10000,
  );
});

test("PO technician sorts by displayed names in both directions and leaves purchases without POs last", () => {
  const { state, results } = fixture();
  const names = (rows: Result[]) =>
    rows.map((r) => poTechnicianLabel(state, r));
  assert.deepEqual(
    names(
      filterResults(results, state, {
        sortBy: "poTechnician",
        sortDirection: "asc",
      }),
    ),
    ["Alex Morgan", "Chris Parker", "Taylor Reed", "—"],
  );
  assert.deepEqual(
    names(
      filterResults(results, state, {
        sortBy: "poTechnician",
        sortDirection: "desc",
      }),
    ),
    ["Taylor Reed", "Chris Parker", "Alex Morgan", "—"],
  );
  assert.equal(
    nextReportSort({ sortBy: "date", sortDirection: "desc" }, "poTechnician")
      .sortDirection,
    "asc",
  );
});

test("CSV and PDF retain separate card-user and PO-technician identities, orphan POs, signed amounts and source state", () => {
  const { state, results } = fixture(),
    before = structuredClone(state),
    beforeResults = structuredClone(results);
  for (const individual of ["Alex Morgan", "Alex card label"]) {
    const filter = {
      individual,
      sortBy: "poTechnician" as const,
      sortDirection: "asc" as const,
    };
    const csv = parse<Record<string, string>>(
      reportCSV(state, results, filter),
      { bom: true, columns: true },
    );
    assert.equal(csv.length, 2);
    const orphan = csv.find((r) => r["Linked PO IDs"] === "p-alex")!;
    assert.equal(orphan["PO technician"], "Alex Morgan");
    assert.equal(orphan["ST technician ID"], "demo-1");
    assert.equal(orphan["Card user"], "No card charge");
    assert.equal(orphan["Amount USD"], "0");
    const linked = csv.find((r) => r["Charge ID"] === "q-alex")!;
    assert.equal(linked["Card user"], "Alex card label");
    assert.equal(linked["PO technician"], "Taylor Reed");
    const pdf = reconciliationPDFModel(state, results, filter);
    assert.equal(pdf.metrics[0].value, "$100.00");
    assert.equal(pdf.metrics[1].value, "$130.00");
    assert.match(pdf.tables[0].rows[0][6], /PO technician: Alex Morgan/);
    assert.match(pdf.tables[0].rows[1][6], /PO technician: Taylor Reed/);
  }
  assert.deepEqual(state, before);
  assert.deepEqual(results, beforeResults);
  const q = state.records.find((r) => r.id === "q-alex")!,
    p = state.records.find((r) => r.id === "p-taylor")!;
  q.amount = p.amount = -5037;
  const refundResults = reconcile(
    state.records,
    state.config,
    [],
    "2026-09-14",
  );
  assert.match(reportCSV(state, refundResults, {}), /"-50.37"/);
  assert.match(
    JSON.stringify(reconciliationPDFModel(state, refundResults, {}).tables),
    /Taylor Reed/,
  );
});

test("report API accepts PO-technician sorting and includes a technician's unmatched POs in CSV and PDF", async () => {
  const prior = process.env.DEMO_MODE;
  process.env.DEMO_MODE = "true";
  try {
    const params =
      "individual=Alex%20Morgan&sortBy=poTechnician&sortDirection=asc";
    const response = await GET(
      new Request("http://127.0.0.1:3000/api/report?" + params),
    );
    assert.equal(response.status, 200);
    const csv = parse<Record<string, string>>(await response.text(), {
      bom: true,
      columns: true,
    });
    assert.ok(
      csv.some(
        (r) =>
          r["Linked PO IDs"] === "PO-2045" &&
          r["PO technician"] === "Alex Morgan",
      ),
    );
    assert.ok(
      csv.some(
        (r) =>
          r["Linked PO IDs"] === "PO-2046" &&
          r["PO technician"] === "Alex Morgan",
      ),
    );
    const pdf = await GET(
      new Request("http://127.0.0.1:3000/api/report?" + params + "&format=pdf"),
    );
    assert.equal(pdf.status, 200);
    assert.equal(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 5)
        .toString(),
      "%PDF-",
    );
  } finally {
    if (prior === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = prior;
  }
});
