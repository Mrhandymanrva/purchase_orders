import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { seed } from "../lib/seed";
import { readState } from "../lib/store";
import { defaults, type RecordItem, type Result, money } from "../lib/domain";
import { reconcile } from "../lib/engine";
import { reportCSV } from "../lib/report";
import { periodRange, scorecard } from "../lib/scorecard";
import {
  reconciliationPDFModel,
  scorecardPDFModel,
} from "../lib/pdf-report-model";
import { reportPDF } from "../lib/pdf-report";
import { GET as report } from "../app/api/report/route";
import { GET as scores } from "../app/api/scorecard/route";
const q = (id: string, amount: number, person: string): RecordItem => ({
  id,
  source: "qbo",
  vendor: "Ferguson",
  amount,
  date: "2026-09-04",
  description: "",
  reference: "",
  currency: "USD",
  account: "Card",
  cardUser: person,
});

test("PDF and CSV agree on selected purchases; shared PO values are not double counted", () => {
  const s = seed();
  s.records = [
    q("charge-a", 10000, "Alice"),
    q("charge-b", 5000, "Bob"),
    { ...q("po", 15000, ""), source: "st", reference: "PO-99" },
  ];
  const g: Result = {
    id: "group",
    charges: ["charge-a", "charge-b"],
    pos: ["po"],
    vendor: "Ferguson",
    amount: 15000,
    difference: 0,
    date: "2026-09-04",
    status: "Matched",
    score: 95,
    reasons: [],
    flags: [],
    kind: "many:1",
  };
  const f = {
    individual: "Alice",
    from: "2026-09-04",
    to: "2026-09-04",
    status: "Matched",
    query: "Ferg",
  };
  const m = reconciliationPDFModel(s, [g], f);
  assert.equal(m.metrics[0].value, "$100.00");
  assert.equal(m.metrics[1].value, "$150.00");
  assert.equal(m.tables[0].rows.length, 1);
  assert.doesNotMatch(JSON.stringify(m.tables), /charge-b|Bob/);
  assert.ok(m.notes.some((s) => s.includes("outside the selected")));
  assert.match(reportCSV(s, [g], f), /charge-a/);
  assert.doesNotMatch(reportCSV(s, [g], f), /charge-b/);
  const all = reconciliationPDFModel(s, [g], {});
  assert.equal(all.metrics[0].value, "$150.00");
  assert.equal(all.metrics[1].note, "1 distinct purchase orders");
  assert.equal(
    reconciliationPDFModel(s, [g], { from: "2026-09-05" }).tables[0].rows
      .length,
    0,
  );
});

test("PDF retains signed refunds and source evidence; historical POs stay outside review variance", () => {
  const s = seed();
  s.rules = [];
  s.decisions = [];
  s.records = [
    {
      ...q("refund", -5037, "Alice"),
      vendor: "Lowe's",
      description: "LOWES #X1037*",
      vendorEvidence: {
        source: "QuickBooks.PrivateNote",
        text: "LOWES #X1037*",
        rule: "qbo-lowes-store-v1",
      },
    },
    { ...q("historical", 9900, ""), source: "st", date: "2026-07-01" },
  ];
  const r = reconcile(s.records, defaults, [], "2026-09-14", [], s.coverage),
    m = reconciliationPDFModel(s, r, {});
  assert.deepEqual(
    m.metrics.map((x) => x.value),
    ["-$50.37", "$99.00", "1", "$50.37"],
  );
  assert.match(JSON.stringify(m.tables), /LOWES #X1037/);
  assert.doesNotMatch(
    JSON.stringify(
      reconciliationPDFModel(s, r, { status: "Needs review" }).tables,
    ),
    /historical/,
  );
});

test("scorecard PDF shares week/month/quarter/year metrics and per-person source attribution", () => {
  const s = seed(),
    r = reconcile(s.records, s.config, s.rules, "2026-09-13");
  for (const unit of ["week", "month", "quarter", "year"] as const) {
    const p = {
      unit,
      year: 2026,
      period:
        unit === "week"
          ? 37
          : unit === "month"
            ? 9
            : unit === "quarter"
              ? 3
              : 1,
    };
    const d = scorecard(s, r, periodRange(p)),
      person = d.rows.find((x) => x.spend !== 0)!,
      m = scorecardPDFModel(s, r, p, person.id);
    assert.equal(m.tables[0].rows.length, 1);
    assert.equal(
      m.tables[1].rows.length,
      d.evidence.filter((e) => e.ownerId === person.id).length,
    );
    assert.equal(m.metrics[0].value, money(person.spend));
    assert.equal(m.metrics[3].value, money(person.vanStock));
  }
});

test("long Unicode reports paginate into complete printable PDFs and empty reports remain valid", async () => {
  const s = seed(),
    before = JSON.stringify(s);
  const empty = await reportPDF(
    reconciliationPDFModel(s, [], { query: "No results" }),
    s,
  );
  assert.equal((await PDFDocument.load(empty)).getPageCount(), 1);
  assert.equal(JSON.stringify(s), before);
  s.records = Array.from({ length: 35 }, (_, i) => ({
    ...q(`record-${i}`, i === 0 ? -5037 : 10000, "Renée Иван"),
    vendor:
      i === 0 ? "Long merchant " + "identifier".repeat(800) : "Lowe’s & Müller",
  }));
  const bytes = await reportPDF(
    reconciliationPDFModel(
      s,
      reconcile(s.records, defaults, [], "2026-09-14"),
      {},
    ),
    s,
    "2026-09-14T12:00:00Z",
  );
  assert.equal(Buffer.from(bytes).subarray(0, 5).toString(), "%PDF-");
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() > 2);
  assert.equal(doc.getTitle(), "Purchase reconciliation");
  for (const p of doc.getPages())
    assert.deepEqual(p.getSize(), { width: 792, height: 612 });
});

test("PDF APIs require authentication, retain filters, leave state unchanged and preserve CSV", async () => {
  const prior = process.env.DEMO_MODE;
  try {
    process.env.DEMO_MODE = "false";
    for (const handler of [report, scores])
      assert.equal(
        (
          await handler(
            new Request("http://127.0.0.1:3000/api/report?format=pdf"),
          )
        ).status,
        403,
      );
    process.env.DEMO_MODE = "true";
    const before = await readState();
    const r = await report(
      new Request(
        "http://127.0.0.1:3000/api/report?format=pdf&individual=Alex%20Morgan&status=Needs%20review&from=2026-09-01&to=2026-09-13",
      ),
    );
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Content-Type"), "application/pdf");
    assert.equal(r.headers.get("Cache-Control"), "no-store");
    assert.match(r.headers.get("Content-Disposition")!, /attachment.*\.pdf/);
    assert.match(
      (await PDFDocument.load(await r.arrayBuffer())).getSubject()!,
      /Alex Morgan.*Needs review/,
    );
    const sc = await scores(
      new Request(
        "http://127.0.0.1:3000/api/scorecard?format=pdf&unit=month&year=2026&period=9",
      ),
    );
    assert.equal(sc.status, 200);
    assert.equal(
      (await PDFDocument.load(await sc.arrayBuffer())).getTitle(),
      "Technician scorecard",
    );
    assert.match(
      (
        await report(new Request("http://127.0.0.1:3000/api/report"))
      ).headers.get("Content-Type")!,
      /text\/csv/,
    );
    assert.deepEqual(await readState(), before);
    for (const query of [
      "format=html",
      "format=pdf&from=bad",
      "format=pdf&from=2026-09-14&to=2026-09-01",
    ])
      assert.equal(
        (await report(new Request("http://127.0.0.1:3000/api/report?" + query)))
          .status,
        400,
      );
    assert.equal(
      (
        await scores(
          new Request(
            "http://127.0.0.1:3000/api/scorecard?format=pdf&unit=month&year=2026&period=13",
          ),
        )
      ).status,
      400,
    );
  } finally {
    if (prior === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = prior;
  }
});
