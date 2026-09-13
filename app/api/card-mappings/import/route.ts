import { createHash, randomUUID } from "node:crypto";
import { authorize, checkOrigin } from "@/lib/auth";
import { readState, changeState, appendAudit, Conflict } from "@/lib/store";
import { parseMappingFile, MAX_UPLOAD_BYTES } from "@/lib/card-import-files";
import { planMappingImport } from "@/lib/card-import";
import {
  readImportReceipt,
  signImportReceipt,
} from "@/lib/card-import-receipt";
import { applyOwnership } from "@/lib/ownership";
import { fingerprint } from "@/lib/engine";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function body(req: Request) {
  const reader = req.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > MAX_UPLOAD_BYTES) {
        await reader.cancel();
        throw Error("Upload must be 2 MB or smaller.");
      }
      chunks.push(r.value);
    }
  return Buffer.concat(chunks);
}
export async function POST(req: Request) {
  let actor: string;
  try {
    actor = authorize(req);
    checkOrigin(req);
  } catch {
    return Response.json({ error: "Unauthorized request" }, { status: 403 });
  }
  try {
    const bytes = await body(req);
    const p = new URL(req.url).searchParams;
    const filename = (p.get("filename") || "")
      .split(/[\\/]/)
      .at(-1)!
      .slice(0, 200);
    const reason = (
      p.get("reason") || "Spreadsheet card mapping update"
    ).trim();
    if (reason.length < 5 || reason.length > 500)
      throw Error("Enter an import reason between 5 and 500 characters.");
    const rows = await parseMappingFile(bytes, filename);
    const state = await readState();
    const plan = planMappingImport(
      state,
      rows,
      reason,
      process.env.QBO_PARENT_CC_ACCOUNT_ID,
    );
    const receipt = {
      revision: state.revision,
      expires: Date.now() + 15 * 60 * 1000,
      filename,
      fileHash: createHash("sha256").update(bytes).digest("hex"),
      reason,
      rows,
    };
    return Response.json(
      {
        revision: state.revision,
        filename,
        counts: plan.counts,
        changes: plan.changes,
        errors: plan.errors,
        token: plan.errors.length ? null : signImportReceipt(receipt),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Unable to read mapping file" },
      { status: 400 },
    );
  }
}
export async function PUT(req: Request) {
  let actor: string;
  try {
    actor = authorize(req);
    checkOrigin(req);
  } catch {
    return Response.json({ error: "Unauthorized request" }, { status: 403 });
  }
  try {
    const { token } = JSON.parse((await body(req)).toString("utf8"));
    if (typeof token !== "string")
      throw Error("Preview the file before applying it.");
    const receipt = readImportReceipt(token);
    const state = await changeState(receipt.revision, (s) => {
      const plan = planMappingImport(
        s,
        receipt.rows,
        receipt.reason,
        process.env.QBO_PARENT_CC_ACCOUNT_ID,
      );
      if (plan.errors.length)
        throw Error(
          plan.errors.map((e) => `Row ${e.row}: ${e.message}`).join("; "),
        );
      const existingIds = new Set((s.cardMappings || []).map((m) => m.id));
      const newIds = new Map(
        plan.mappings
          .filter((m) => !existingIds.has(m.id))
          .map((m) => [m.id, randomUUID()]),
      );
      const actual = (m: (typeof plan.mappings)[number]) => ({
        ...m,
        id: newIds.get(m.id) || m.id,
      });
      s.cardMappings = plan.mappings.map(actual);
      const before = s.records;
      s.records = applyOwnership(s.records, s);
      const affectedChargeIds = s.records
        .filter(
          (r, i) =>
            r.cardUser !== before[i].cardUser ||
            r.ownershipSource !== before[i].ownershipSource,
        )
        .map((r) => r.id);
      const invalidatedDecisionIds = s.decisions
        .filter(
          (d) =>
            fingerprint(s.records, [...d.charges, ...d.pos]) !== d.fingerprint,
        )
        .map((d) => d.resultId);
      appendAudit(s, actor, "Card mapping spreadsheet applied", {
        filename: receipt.filename,
        fileHash: receipt.fileHash,
        reason: receipt.reason,
        counts: plan.counts,
        changes: plan.changes
          .filter((c) => c.kind !== "unchanged")
          .map((c) => ({ ...c, after: actual(c.after) })),
        affectedChargeIds,
        invalidatedDecisionIds,
      });
    });
    return Response.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Import failed" },
      { status: e instanceof Conflict ? 409 : 400 },
    );
  }
}
