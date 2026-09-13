import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { required } from "./integration-transport";
function key() {
  const value = Buffer.from(required("TOKEN_ENCRYPTION_KEY"), "base64");
  if (value.length !== 32)
    throw Error(
      "Integration TOKEN_ENCRYPTION_KEY must contain 32 base64-encoded bytes",
    );
  return value;
}
export function encryptToken(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64",
  );
}
export function decryptToken(value: string) {
  const bytes = Buffer.from(value, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    decipher.update(bytes.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}
