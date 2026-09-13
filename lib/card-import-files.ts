import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import { type ImportRow } from "./card-import";
import { compatibleXlsx } from "./xlsx-compat";
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024,
  MAX_IMPORT_ROWS = 1000;
const headers: Record<string, string> = {
  stpersonid: "personId",
  servicetitanpersonid: "personId",
  mappingid: "id",
  subaccountid: "accountId",
  quickbooksaccountid: "accountId",
  quickbookssubaccountid: "accountId",
  accountid: "accountId",
  subaccountname: "accountName",
  quickbookssubaccount: "accountName",
  accountname: "accountName",
  subaccount: "accountName",
  carduser: "cardUser",
  cardholder: "cardUser",
  employee: "cardUser",
  employeename: "cardUser",
  effectivefrom: "from",
  startdate: "from",
  from: "from",
  effectivethrough: "through",
  enddate: "through",
  through: "through",
  reason: "reason",
  notes: "reason",
};
// Bound declared ZIP expansion before ExcelJS reads workbook XML. Encrypted/ZIP64 archives are not supported.
export function validateXlsxArchive(buffer: Buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw Error("This is not a valid .xlsx file.");
  const count = buffer.readUInt16LE(end + 10),
    offset = buffer.readUInt32LE(end + 16);
  if (count > 2000 || count === 65535 || offset >= end)
    throw Error("Workbook archive exceeds the import limits.");
  let cursor = offset,
    total = 0;
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50)
      throw Error("Invalid workbook ZIP directory.");
    const flags = buffer.readUInt16LE(cursor + 8),
      size = buffer.readUInt32LE(cursor + 24);
    if (flags & 1 || size === 0xffffffff)
      throw Error("Encrypted or ZIP64 workbooks are not supported.");
    total += size;
    if (total > 20 * 1024 * 1024)
      throw Error(
        "Workbook expands beyond the 20 MB limit. Use a simple mapping workbook or CSV.",
      );
    cursor +=
      46 +
      buffer.readUInt16LE(cursor + 28) +
      buffer.readUInt16LE(cursor + 30) +
      buffer.readUInt16LE(cursor + 32);
  }
  if (cursor > end) throw Error("Invalid workbook ZIP directory.");
}
function cell(value: ExcelJS.CellValue, row: number): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw Error(
        `Row ${row}: use text for identifiers and whole dates; numeric value is unsafe.`,
      );
    return String(value);
  }
  if (typeof value === "object") {
    if ("formula" in value || "sharedFormula" in value)
      throw Error(
        `Row ${row}: formulas are not accepted. Paste their values first.`,
      );
    if ("richText" in value)
      return value.richText
        .map((r) => r.text)
        .join("")
        .trim();
  }
  throw Error(`Row ${row}: unsupported cell value. Use plain text or a date.`);
}
const date = (s: string) => {
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [m, d, y] = s.split("/");
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return s;
};
export async function parseMappingFile(
  buffer: Buffer,
  filename: string,
): Promise<ImportRow[]> {
  if (!buffer.length) throw Error("The uploaded file is empty.");
  if (buffer.length > MAX_UPLOAD_BYTES)
    throw Error("File must be 2 MB or smaller.");
  let grid: string[][];
  if (/\.csv$/i.test(filename)) {
    grid = parse(buffer.toString("utf8"), {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      max_record_size: 20000,
    });
  } else if (/\.xlsx$/i.test(filename)) {
    validateXlsxArchive(buffer);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await compatibleXlsx(buffer)) as any);
    const named = wb.worksheets.find(
      (s) => s.name.toLowerCase() === "card mappings",
    );
    const sheets = wb.worksheets.filter((s) => s.actualRowCount > 0);
    const sheet = named || (sheets.length === 1 ? sheets[0] : undefined);
    if (!sheet)
      throw Error(
        'Use one worksheet or name the mapping worksheet "Card mappings".',
      );
    if (sheet.rowCount > MAX_IMPORT_ROWS + 1 || sheet.columnCount > 30)
      throw Error("Workbook exceeds 1,000 rows or 30 columns.");
    grid = [];
    for (let r = 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const values: string[] = [];
      for (let c = 1; c <= sheet.columnCount; c++)
        values.push(cell(row.getCell(c).value, r));
      grid.push(values);
    }
  } else
    throw Error(
      "Upload an .xlsx or .csv file. Save older .xls workbooks as .xlsx first.",
    );
  if (grid.length > MAX_IMPORT_ROWS + 1)
    throw Error("Import is limited to 1,000 rows.");
  if (!grid.length) throw Error("No header row found.");
  const keys = grid[0].map(
    (h) =>
      headers[
        h
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
      ],
  );
  const used = keys.filter(Boolean);
  if (new Set(used).size !== used.length)
    throw Error("Duplicate mapping column headers.");
  if (
    !used.includes("cardUser") ||
    !used.includes("from") ||
    !used.some((k) => ["id", "accountId", "accountName"].includes(k))
  )
    throw Error(
      "Required columns: Subaccount ID (or name), Card user, Effective from.",
    );
  const rows: ImportRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const values = grid[i].map((v) => String(v ?? "").trim());
    if (values.every((v) => !v)) continue;
    if (values.slice(keys.length).some(Boolean))
      throw Error(`Row ${i + 1}: extra data without a column header.`);
    const row: Record<string, unknown> = { row: i + 1 };
    keys.forEach((key, c) => {
      if (key && values[c]) {
        if (values[c].length > 500)
          throw Error(`Row ${i + 1}: cell exceeds 500 characters.`);
        row[key] =
          key === "from" || key === "through" ? date(values[c]) : values[c];
      }
    });
    rows.push(row as ImportRow);
  }
  if (!rows.length)
    throw Error(
      "No mapping rows found. Fill in the template before uploading.",
    );
  return rows;
}
