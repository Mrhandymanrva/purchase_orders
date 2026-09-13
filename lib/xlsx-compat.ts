import JSZip from "jszip";
import {
  DOMParser,
  XMLSerializer,
  type Node,
  type Element,
} from "@xmldom/xmldom";
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
// ExcelJS assumes unprefixed SpreadsheetML elements. OpenXML SDK files use
// namespace prefixes; normalize element names, preserving values and r:id attributes.
// See https://github.com/exceljs/exceljs/issues/1437.
function normalize(xml: string) {
  xml = xml.replace(/^\uFEFF/, "");
  if (/<!DOCTYPE/i.test(xml))
    throw Error("Workbook XML document types are not supported.");
  const doc = new DOMParser({
    onError: () => {
      throw Error("Invalid workbook XML.");
    },
  }).parseFromString(xml, "application/xml");
  if (!doc.documentElement || doc.documentElement.namespaceURI !== MAIN)
    return xml;
  function copy(node: Node, depth: number): Node {
    if (depth > 100)
      throw Error("Workbook XML nesting exceeds the import limit.");
    if (node.nodeType !== 1) return node.cloneNode(true);
    const element = node as Element;
    const result = doc.createElementNS(
      element.namespaceURI,
      element.namespaceURI === MAIN ? element.localName! : element.tagName,
    );
    for (let i = 0; i < element.attributes.length; i++) {
      const a = element.attributes.item(i)!;
      result.setAttributeNS(a.namespaceURI, a.name, a.value);
    }
    for (let child = node.firstChild; child; child = child.nextSibling)
      result.appendChild(copy(child, depth + 1));
    return result;
  }
  return new XMLSerializer().serializeToString(copy(doc.documentElement, 0));
}
export async function compatibleXlsx(bytes: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes),
    out = new JSZip();
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = entry.nodeStream();
      stream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > 20 * 1024 * 1024) {
          stream.pause();
          reject(Error("Workbook expands beyond the 20 MB import limit."));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    const content = Buffer.concat(chunks);
    out.file(
      entry.name,
      /\.xml$/i.test(entry.name)
        ? normalize(content.toString("utf8"))
        : content,
    );
  }
  return out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
