import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { importRowSchema } from "./card-import";
const globalKey = globalThis as unknown as { cardImportKey?: Buffer };
function key() {
  return (
    process.env.APP_PASSWORD || (globalKey.cardImportKey ??= randomBytes(32))
  );
}
const schema = z.object({
  revision: z.number().int(),
  expires: z.number(),
  filename: z.string().max(200),
  fileHash: z.string().length(64),
  reason: z.string().min(5).max(500),
  rows: z.array(importRowSchema).min(1).max(1000),
});
export type ImportReceipt = z.infer<typeof schema>;
export function signImportReceipt(receipt: ImportReceipt) {
  const body = Buffer.from(JSON.stringify(receipt)).toString("base64url");
  return (
    body + "." + createHmac("sha256", key()).update(body).digest("base64url")
  );
}
export function readImportReceipt(token: string) {
  if (token.length > 2 * 1024 * 1024)
    throw Error("Preview exceeds size limit.");
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) throw Error("Invalid import preview.");
  const expected = createHmac("sha256", key()).update(body).digest(),
    actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw Error(
      "Import preview was changed or expired after a restart. Preview the file again.",
    );
  const receipt = schema.parse(
    JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
  );
  if (receipt.expires < Date.now())
    throw Error("Import preview expired. Preview the file again.");
  return receipt;
}
