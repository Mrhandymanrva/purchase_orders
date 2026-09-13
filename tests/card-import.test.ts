import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { compatibleXlsx } from "../lib/xlsx-compat";
import { readFile } from "node:fs/promises";
import { seed } from "../lib/seed";
import { planMappingImport, type ImportRow } from "../lib/card-import";
import {
  parseMappingFile,
  validateXlsxArchive,
  MAX_UPLOAD_BYTES,
} from "../lib/card-import-files";
import {
  readImportReceipt,
  signImportReceipt,
} from "../lib/card-import-receipt";
import { applyOwnership } from "../lib/ownership";
import { POST, PUT } from "../app/api/card-mappings/import/route";
import { GET as exportMappings } from "../app/api/card-mappings/export/route";
import { readState, verifyAudit } from "../lib/store";
import { reportCSV } from "../lib/report";
import { reconcile } from "../lib/engine";
const row = (v: Partial<ImportRow> = {}): ImportRow => ({
  row: 2,
  accountId: "demo-81",
  cardUser: "Jordan Smith",
  ...v,
});
const reason = "Verified cardholder roster";

test("two-column card mapping files work without dates and preserve card IDs as text", async () => {
  const rows = await parseMappingFile(
    Buffer.from("Subaccount ID,Card user\n00123,Jordan Smith\n"),
    "cards.csv",
  );
  assert.equal(rows[0].accountId, "00123");
  const result = planMappingImport(seed(), rows, reason);
  assert.deepEqual(result.errors, []);
  assert.equal(result.mappings[0].from, undefined);
  assert.equal(result.mappings[0].through, undefined);
});
test("downloadable template is readable, and its blank rows are never imported", async () => {
  const bytes = await readFile(
    new URL("../public/templates/card-mappings-template.xlsx", import.meta.url),
  );
  await assert.rejects(
    parseMappingFile(bytes, "template.xlsx"),
    /No mapping rows/,
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await compatibleXlsx(bytes)) as any);
  const sheet = workbook.getWorksheet("Card mappings")!;
  assert.deepEqual(sheet.getRow(1).values, [
    ,
    "Mapping ID",
    "Subaccount ID",
    "Subaccount name",
    "Card user",
    "ST Person ID",
    "Reason",
  ]);
  sheet.getRow(2).getCell(2).value = "00123";
  sheet.getRow(2).getCell(4).value = "Jordan Smith";
  const filled = await parseMappingFile(
    Buffer.from(await workbook.xlsx.writeBuffer()),
    "filled-template.xlsx",
  );
  assert.equal(filled.length, 1);
  assert.equal(filled[0].accountId, "00123");
  assert.equal(filled[0].cardUser, "Jordan Smith");
  assert.equal(filled[0].from, undefined);
});
const plan = (s: ReturnType<typeof seed>, rows: ImportRow[]) =>
  planMappingImport(s, rows, reason);
test("25-card roster is idempotent; corrections keep identity and omissions keep mappings", () => {
  const s = seed(),
    rows = Array.from({ length: 25 }, (_, i) =>
      row({
        row: i + 2,
        accountId: String(100 + i),
        cardUser: `Employee ${i + 1}`,
      }),
    );
  const first = plan(s, rows);
  assert.deepEqual(first.errors, []);
  assert.equal(first.counts.new, 25);
  s.cardMappings = first.mappings;
  const repeat = plan(s, rows);
  assert.equal(repeat.counts.unchanged, 25);
  assert.equal(repeat.counts.new, 0);
  assert.deepEqual(repeat.mappings, s.cardMappings);
  const changed = plan(s, [{ ...rows[0], cardUser: "Corrected Employee" }]);
  assert.equal(changed.counts.updated, 1);
  assert.equal(changed.mappings.length, 25);
  assert.equal(changed.mappings[0].id, s.cardMappings[0].id);
  assert.equal(changed.mappings[1].cardUser, "Employee 2");
});
test("repeat uploads correct the same card for its full history and ignore legacy date columns", () => {
  const s = seed();
  s.cardMappings = plan(s, [row()]).mappings;
  const id = s.cardMappings[0].id;
  const next = plan(s, [
    row({
      from: "2026-09-10",
      through: "2026-09-11",
      cardUser: "Correct Employee",
    }),
  ]);
  assert.equal(next.counts.closed, 0);
  assert.equal(next.counts.new, 0);
  assert.equal(next.counts.updated, 1);
  assert.equal(next.mappings.length, 1);
  assert.equal(next.mappings[0].id, id);
  assert.equal(next.mappings[0].from, undefined);
  assert.equal(next.mappings[0].through, undefined);
  s.cardMappings = next.mappings;
  assert.ok(
    applyOwnership(s.records, s)
      .filter((r) => r.accountId === "demo-81")
      .every((r) => r.cardUser === "Correct Employee"),
  );
  assert.equal(
    plan(s, [row({ cardUser: "Correct Employee", from: "not a date" })]).counts
      .unchanged,
    1,
  );
});

test("Mapping ID preserves identity on employee corrections and cannot move to another card", () => {
  const s = seed();
  s.cardMappings = plan(s, [row()]).mappings;
  const id = s.cardMappings[0].id;
  const result = plan(s, [row({ id, cardUser: "Correct Employee" })]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.counts.updated, 1);
  assert.equal(result.mappings.length, 1);
  assert.equal(result.mappings[0].id, id);
  assert.match(
    plan(s, [row({ id: "missing" })]).errors[0].message,
    /not found/,
  );
  assert.match(
    plan(s, [row({ id, accountId: "other" })]).errors[0].message,
    /different subaccount/,
  );
});

test("duplicate cards block the plan even with different legacy dates and never mutate input", () => {
  const s = seed();
  s.cardMappings = plan(s, [row()]).mappings;
  const before = structuredClone(s);
  assert.ok(
    plan(s, [
      row(),
      row({ row: 3, from: "2026-09-10", cardUser: "Other Employee" }),
    ]).errors.some((e) => e.message.includes("Duplicate")),
  );
  assert.ok(plan(s, [row({ cardUser: "" })]).errors.length);
  assert.deepEqual(s, before);
});

test("names must resolve uniquely; explicit new IDs are supported and parent ID is rejected", () => {
  const s = seed();
  const name = s.records.find((r) => r.accountId === "demo-81")!.account;
  assert.equal(
    plan(s, [row({ accountId: undefined, accountName: name })]).mappings[0]
      .accountId,
    "demo-81",
  );
  assert.ok(
    plan(s, [row({ accountId: undefined, accountName: "Unknown" })]).errors
      .length,
  );
  s.records.push({
    ...s.records.find((r) => r.accountId === "demo-81")!,
    id: "extra",
    accountId: "other-child",
  });
  assert.match(
    plan(s, [row({ accountId: undefined, accountName: name })]).errors[0]
      .message,
    /ambiguous/,
  );
  assert.equal(
    plan(s, [row({ accountId: "new-child", accountName: "Main CC: New card" })])
      .counts.new,
    1,
  );
  assert.ok(planMappingImport(s, [row()], reason, "demo-81").errors.length);
});
test("individual overrides survive bulk changes; linked PO reports follow assigned card user", () => {
  const s = seed();
  s.cardAssignments = { "Q-1045": "Specific User" };
  s.cardMappings = plan(s, [row()]).mappings;
  s.records = applyOwnership(s.records, s);
  assert.equal(
    s.records.find((r) => r.id === "Q-1045")?.cardUser,
    "Specific User",
  );
  const csv = reportCSV(
    s,
    reconcile(s.records, s.config, s.rules, "2026-09-13"),
    { individual: "Jordan Smith" },
  );
  assert.ok(csv.includes("PO-2041"));
  assert.ok(csv.includes("demo-81"));
});
test("CSV supports BOM, quoted names, dates and IDs with leading zeros", async () => {
  const rows = await parseMappingFile(
    Buffer.from(
      '\uFEFFSubaccount ID,Card user,Effective from\r\n00123,"Smith, Jordan",9/1/2026\r\n',
    ),
    "roster.csv",
  );
  assert.equal(rows[0].accountId, "00123");
  assert.equal(rows[0].cardUser, "Smith, Jordan");
  assert.equal(rows[0].from, "2026-09-01");
  await assert.rejects(
    parseMappingFile(
      Buffer.from(
        "Subaccount ID,Account ID,Card user,Effective from\n1,1,Name,2026-09-01",
      ),
      "x.csv",
    ),
    /Duplicate/,
  );
  await assert.rejects(
    parseMappingFile(
      Buffer.from("Subaccount ID,Card user,Effective from\n"),
      "x.csv",
    ),
    /No mapping rows/,
  );
});
test("XLSX reads actual dates and rejects formula cells, unsafe numbers and oversized files", async () => {
  const wb = new ExcelJS.Workbook(),
    s = wb.addWorksheet("Card mappings");
  wb.addWorksheet("Instructions").addRow(["Read this"]);
  s.addRow(["Subaccount ID", "Card user", "Effective from"]);
  s.addRow(["00123", "Jordan Smith", new Date("2026-09-01T00:00:00Z")]);
  s.getCell("C2").numFmt = "yyyy-mm-dd";
  const bytes = () => wb.xlsx.writeBuffer().then((b) => Buffer.from(b));
  assert.equal(
    (await parseMappingFile(await bytes(), "roster.xlsx"))[0].from,
    "2026-09-01",
  );
  s.getCell("B2").value = { formula: '"Jordan Smith"', result: "Jordan Smith" };
  await assert.rejects(parseMappingFile(await bytes(), "x.xlsx"), /formulas/);
  s.getCell("B2").value = "Jordan Smith";
  s.getCell("A2").value = 9007199254740992;
  await assert.rejects(parseMappingFile(await bytes(), "x.xlsx"), /unsafe/);
  await assert.rejects(
    parseMappingFile(Buffer.alloc(MAX_UPLOAD_BYTES + 1), "x.csv"),
    /2 MB/,
  );
  assert.throws(() => validateXlsxArchive(Buffer.from("invalid")), /valid/);
});
test("signed preview cannot be tampered with or applied after expiry", () => {
  const receipt = {
    policy: "card-lifetime-v1" as const,
    revision: 1,
    expires: Date.now() + 10000,
    filename: "cards.csv",
    fileHash: "a".repeat(64),
    reason,
    rows: [row()],
  };
  const token = signImportReceipt(receipt);
  assert.deepEqual(readImportReceipt(token), receipt);
  assert.throws(
    () =>
      readImportReceipt(
        signImportReceipt({ ...receipt, policy: undefined } as any),
      ),
    /workflow changed/,
  );
  assert.throws(() => readImportReceipt("A" + token.slice(1)), /changed/);
  assert.throws(
    () =>
      readImportReceipt(
        signImportReceipt({ ...receipt, expires: Date.now() - 1 }),
      ),
    /expired/,
  );
});
test("API previews without mutation, atomically imports, rejects stale repeats, exports and audits", async () => {
  const previous = process.env.DEMO_MODE;
  process.env.DEMO_MODE = "true";
  try {
    const base = "http://127.0.0.1:3000",
      headers = { origin: base };
    const initial = await readState();
    const csv =
      "Subaccount ID,Card user\n" +
      Array.from(
        { length: 25 },
        (_, i) => `${i ? 900 + i : "demo-81"},Upload Person ${i}`,
      ).join("\n");
    const preview = async (text: string) =>
      POST(
        new Request(base + "/api/card-mappings/import?filename=roster.csv", {
          method: "POST",
          headers,
          body: text,
        }),
      );
    const apply = async (token: string) =>
      PUT(
        new Request(base + "/api/card-mappings/import", {
          method: "PUT",
          headers,
          body: JSON.stringify({ token }),
        }),
      );
    const p = await (await preview(csv)).json();
    assert.equal(p.counts.new, 25);
    assert.equal((await readState()).revision, initial.revision);
    const saved = await apply(p.token);
    assert.equal(saved.status, 200);
    const s = await saved.json();
    assert.equal(s.cardMappings.length, 25);
    assert.equal(
      s.records.find((r: any) => r.id === "Q-1041").cardUser,
      "Upload Person 0",
    );
    assert.ok(verifyAudit(s.audit));
    assert.equal((await apply(p.token)).status, 409);
    const same = await (await preview(csv)).json();
    assert.equal(same.counts.unchanged, 25);
    assert.equal((await apply(same.token)).status, 200);
    assert.equal((await readState()).cardMappings?.length, 25);
    const revised = await (
      await preview(csv.replace("Upload Person 0", "Corrected Card User"))
    ).json();
    assert.equal(revised.counts.updated, 1);
    const revisedResponse = await apply(revised.token);
    assert.equal(revisedResponse.status, 200);
    const exported = await exportMappings(
      new Request(base + "/api/card-mappings/export"),
    );
    const exportedText = await exported.text();
    assert.ok(exportedText.includes("Corrected Card User"));
    assert.ok(!exportedText.includes("Effective from"));
    const roundtrip = await (await preview(exportedText)).json();
    assert.equal(roundtrip.counts.unchanged, 25);
    const beforeInvalid = await readState();
    const bad = await (
      await preview(csv + "\nnew-id,Valid Person\nbad-id,")
    ).json();
    assert.ok(bad.errors.length);
    assert.equal(bad.token, null);
    assert.deepEqual(await readState(), beforeInvalid);
    assert.equal(
      (
        await PUT(
          new Request(base + "/api/card-mappings/import", {
            method: "PUT",
            headers,
            body: JSON.stringify({ token: "tampered" }),
          }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await POST(
          new Request(base + "/api/card-mappings/import?filename=x.csv", {
            method: "POST",
            headers: { origin: "https://wrong.example" },
            body: csv,
          }),
        )
      ).status,
      403,
    );
  } finally {
    if (previous === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = previous;
  }
});
