import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { State } from "./domain";
import { ENGINE_VERSION } from "./engine";
import type { PDFReport, PDFTable } from "./pdf-report-model";

export const PDF_REPORT_VERSION = "1.0";
const W = 792,
  H = 612,
  M = 32,
  BODY = W - M * 2,
  BOTTOM = 562;
const color = {
  ink: rgb(0.13, 0.2, 0.18),
  green: rgb(0.12, 0.31, 0.25),
  muted: rgb(0.38, 0.45, 0.42),
  line: rgb(0.83, 0.87, 0.84),
  pale: rgb(0.95, 0.97, 0.95),
  lime: rgb(0.76, 0.87, 0.45),
  amber: rgb(0.53, 0.36, 0.05),
  white: rgb(1, 1, 1),
};
let fontFiles: Promise<Buffer[]> | undefined;
function fonts() {
  return (fontFiles ??= Promise.all([
    readFile(path.join(process.cwd(), "assets/fonts/NotoSans-Regular.ttf")),
    readFile(path.join(process.cwd(), "assets/fonts/NotoSans-SemiBold.ttf")),
  ]).catch((error) => {
    fontFiles = undefined;
    throw error;
  }));
}
const stamp = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date(iso)) + " ET";

export async function reportPDF(
  model: PDFReport,
  state: State,
  generatedAt = new Date().toISOString(),
) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await fonts();
  const regular = await doc.embedFont(regularBytes, { subset: true });
  const bold = await doc.embedFont(boldBytes, { subset: true });
  const charset = new Set(regular.getCharacterSet());
  let escapedGlyph = false;
  const clean = (value: string) =>
    [
      ...String(value)
        .normalize("NFC")
        .replace(/[\u2010-\u2015\u2212]/g, "-")
        .replace(/[\t\u00a0\u202f]/g, " ")
        .replace(
          /[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
          "",
        ),
    ]
      .map((char) => {
        if (char === "\n" || charset.has(char.codePointAt(0)!)) return char;
        escapedGlyph = true;
        return `[U+${char.codePointAt(0)!.toString(16).toUpperCase()}]`;
      })
      .join("");
  doc.setTitle(model.title);
  doc.setAuthor("Mr. Handyman of Richmond");
  doc.setCreator(`Richmond PDF ${PDF_REPORT_VERSION}`);
  doc.setSubject(
    model.filters.join(" | ") +
      ` | Workspace revision ${state.revision} | Engine ${ENGINE_VERSION}`,
  );
  doc.setCreationDate(new Date(generatedAt));
  doc.setModificationDate(new Date(generatedAt));
  let page: PDFPage,
    y = 0;
  const text = (
    value: string,
    x: number,
    top: number,
    size = 9,
    font = regular,
    ink = color.ink,
  ) =>
    page.drawText(clean(value), {
      x,
      y: H - top - size,
      size,
      font,
      color: ink,
    });
  const line = (top: number) =>
    page.drawLine({
      start: { x: M, y: H - top },
      end: { x: W - M, y: H - top },
      thickness: 0.5,
      color: color.line,
    });
  const box = (
    x: number,
    top: number,
    width: number,
    height: number,
    fill = color.pale,
  ) =>
    page.drawRectangle({ x, y: H - top - height, width, height, color: fill });
  function wrap(
    value: string,
    width: number,
    size = 9,
    font: PDFFont = regular,
  ): string[] {
    const output: string[] = [];
    for (const paragraph of clean(value).split("\n")) {
      let current = "";
      for (const word of paragraph.split(/ +/).filter(Boolean)) {
        const joined = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(joined, size) <= width) {
          current = joined;
          continue;
        }
        if (current) {
          output.push(current);
          current = "";
        }
        // Split unusually long identifiers without dropping any characters.
        for (const char of word) {
          if (current && font.widthOfTextAtSize(current + char, size) > width) {
            output.push(current);
            current = "";
          }
          current += char;
        }
      }
      output.push(current);
    }
    return output;
  }
  function paragraph(
    value: string,
    top: number,
    width = BODY,
    size = 8.3,
    ink = color.muted,
  ) {
    const lines = wrap(value, width, size);
    lines.forEach((s, i) =>
      text(s, M, top + i * (size + 3), size, regular, ink),
    );
    return lines.length * (size + 3);
  }
  function addPage(first = false) {
    page = doc.addPage([W, H]);
    box(M, 29, 4, 25, color.lime);
    text("richmond.", M + 13, 26, 21, bold, color.green);
    text(
      state.mode === "demo" ? "SAMPLE DATA" : "RICHMOND OPERATIONS",
      W - 211,
      28,
      8,
      bold,
      color.green,
    );
    text(
      `Generated ${stamp(generatedAt)}`,
      W - 211,
      42,
      7.4,
      regular,
      color.muted,
    );
    text(model.title, M, first ? 76 : 69, first ? 25 : 17, bold);
    if (first) text(model.subtitle, M, 110, 9, regular, color.muted);
    y = first ? 134 : 99;
    if (!first) {
      const scope = clean(model.filters.slice(0, 2).join(" | "));
      y += paragraph(
        scope.length > 170 ? scope.slice(0, 167) + "..." : scope,
        y,
        BODY,
        8,
      );
      y += 12;
    }
  }
  addPage(true);
  // Filter labels wrap at their full length, including lengthy searches/names.
  for (const filter of model.filters) {
    for (const s of wrap(filter, BODY, 8.3)) {
      if (y > 370) {
        addPage();
      }
      text(s, M, y, 8.3, regular, color.muted);
      y += 11.3;
    }
  }
  y += 13;
  if (y + 240 > BOTTOM) addPage();
  const metricWidth = (BODY - 24) / 4;
  model.metrics.forEach((metric, i) => {
    const x = M + i * (metricWidth + 8);
    box(x, y, metricWidth, 66);
    text(metric.label.toUpperCase(), x + 12, y + 10, 7.4, bold, color.muted);
    let size = 21;
    while (
      size > 10 &&
      bold.widthOfTextAtSize(clean(metric.value), size) > metricWidth - 24
    )
      size -= 0.5;
    text(
      metric.value,
      x + 12,
      y + 23,
      size,
      bold,
      i === 2 ? color.amber : color.green,
    );
    text(metric.note, x + 12, y + 51, 6.7, regular, color.muted);
  });
  y += 80;
  const coverage = state.coverage
    ? `Imported history: cards ${state.coverage.chargesFrom} to ${state.coverage.through}; POs ${state.coverage.posFrom} to ${state.coverage.through}.`
    : "No completed source import. Totals may not represent a complete reporting period.";
  y += paragraph(coverage, y);
  y += paragraph(
    `Last sync: ${state.lastSync ? stamp(state.lastSync) : state.mode === "demo" ? "Sample records" : "No successful sync"}.`,
    y,
  );
  for (const note of model.notes) {
    y += paragraph(note, y) + 2;
  }
  y += 13;

  function tableHeading(table: PDFTable, continued = false) {
    if (y + 72 > BOTTOM) addPage();
    text(
      table.title + (continued ? " (continued)" : ""),
      M,
      y,
      11,
      bold,
      color.green,
    );
    y += 23;
    box(M, y, BODY, 25, color.green);
    let x = M;
    table.columns.forEach((c) => {
      const size = 7.1;
      const width = bold.widthOfTextAtSize(clean(c.label), size);
      text(
        c.label,
        c.align === "right" ? x + c.width - width - 9 : x + 9,
        y + 8,
        size,
        bold,
        color.white,
      );
      x += c.width;
    });
    y += 25;
  }
  for (const table of model.tables) {
    tableHeading(table);
    if (!table.rows.length) {
      box(M, y, BODY, 50);
      text(table.empty, M + 12, y + 17, 9, regular, color.muted);
      y += 63;
      continue;
    }
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex++) {
      const cells = table.columns.map((c, i) =>
        wrap(
          table.rows[rowIndex][i] || "",
          c.width - 18,
          8.4,
          c.bold ? bold : regular,
        ),
      );
      const count = Math.max(1, ...cells.map((c) => c.length)),
        leading = 11.5;
      const fullHeight = count * leading + 17;
      if (y + fullHeight > BOTTOM && fullHeight <= 350) {
        addPage();
        tableHeading(table, true);
      }
      let offset = 0;
      while (offset < count) {
        let fit = Math.floor((BOTTOM - y - 17) / leading);
        if (fit < Math.min(2, count - offset)) {
          addPage();
          tableHeading(table, true);
          fit = Math.floor((BOTTOM - y - 17) / leading);
        }
        const n = Math.min(fit, count - offset),
          height = n * leading + 17;
        if (rowIndex % 2 === 0) box(M, y, BODY, height);
        const tone = table.tones?.[rowIndex];
        if (tone === "review") box(M, y, 2, height, color.amber);
        if (tone === "done") box(M, y, 2, height, color.green);
        let x = M;
        cells.forEach((lines, i) => {
          const c = table.columns[i],
            font = c.bold ? bold : regular;
          lines.slice(offset, offset + n).forEach((s, j) => {
            const width = font.widthOfTextAtSize(s, 8.4);
            text(
              s,
              c.align === "right" ? x + c.width - width - 9 : x + 9,
              y + 8 + j * leading,
              8.4,
              font,
            );
          });
          x += c.width;
        });
        y += height;
        line(y);
        offset += n;
      }
    }
    y += 22;
  }
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    page = p;
    line(577);
    text(
      `INTERNAL | Revision ${state.revision} | Engine ${ENGINE_VERSION} | All amounts USD`,
      M,
      584,
      7,
      regular,
      color.muted,
    );
    const label = `Page ${i + 1} of ${pages.length}`;
    text(
      label,
      W - M - regular.widthOfTextAtSize(label, 7),
      584,
      7,
      regular,
      color.muted,
    );
    if (escapedGlyph)
      text(
        "Unavailable characters use [U+...] codes.",
        M,
        598,
        5.6,
        regular,
        color.muted,
      );
  });
  return doc.save();
}
