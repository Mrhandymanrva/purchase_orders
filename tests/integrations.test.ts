import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cents,
  mapQBO,
  mapST,
  readQBO,
  getJSON,
  encryptToken,
  decryptToken,
} from "../lib/integrations";
const qbo = {
  Id: "1",
  PaymentType: "CreditCard",
  TotalAmt: 12.34,
  TxnDate: "2026-09-01",
  EntityRef: { value: "7", name: "Ferguson" },
  AccountRef: { value: "8" },
  DocNumber: "Not a PO",
};
test("decimal conversion does not use binary float arithmetic", () => {
  assert.equal(cents("12.34"), 1234);
  assert.equal(cents(-12.34), -1234);
  assert.equal(cents("0.1"), 10);
  assert.throws(() => cents(12.345));
});
test("QBO charges and credits map correctly without treating DocNumber as PO", () => {
  assert.equal(mapQBO(qbo)?.amount, 1234);
  assert.equal(mapQBO({ ...qbo, Credit: true })?.amount, -1234);
  assert.equal(mapQBO(qbo)?.reference, "");
  assert.equal(
    mapQBO({ ...qbo, PrivateNote: "For PO-123" })?.reference,
    "PO-123",
  );
  assert.equal(mapQBO({ ...qbo, PaymentType: "Cash" }), null);
  assert.throws(() => mapQBO({ ...qbo, CurrencyRef: { value: "CAD" } }));
});
test("ST pending POs retain their source status; canceled POs are excluded and vendor identity is required", () => {
  const po = {
    id: 1,
    vendorId: 7,
    number: "PO-1",
    date: "2026-09-01T00:00:00Z",
    createdOn: "2026-09-01T12:00:00Z",
    total: 12.34,
    status: "Sent",
  };
  assert.equal(mapST(po, new Map([["7", "Ferguson"]]))?.amount, 1234);
  const pending = mapST(
    { ...po, status: "Pending" },
    new Map([["7", "Ferguson"]]),
  );
  assert.equal(pending?.amount, 1234);
  assert.equal(pending?.poStatus, "Pending");
  assert.equal(mapST({ ...po, status: "Canceled" }, new Map()), null);
  assert.equal(mapST({ ...po, status: "Cancelled" }, new Map()), null);
  assert.throws(() => mapST(po, new Map()));
});
test("QBO adapter uses GET only and account-scoped pagination", async () => {
  process.env.QBO_CARD_ACCOUNT_IDS = "8";
  let calls = 0;
  const mock: typeof fetch = async (_url, init) => {
    assert.equal(init?.method, "GET");
    calls++;
    return Response.json({
      QueryResponse: {
        Purchase:
          calls === 1
            ? Array.from({ length: 1000 }, (_, i) => ({
                ...qbo,
                Id: String(i),
              }))
            : [
                { ...qbo, Id: "1001" },
                { ...qbo, Id: "1002", AccountRef: { value: "excluded" } },
              ],
      },
    });
  };
  const rows = await readQBO(
    "test-token",
    "realm",
    "2026-09-01",
    "2026-09-13",
    mock,
  );
  assert.equal(calls, 2);
  assert.equal(rows.length, 1001);
});
test("rate limit retries; unauthorized and untrusted hosts fail closed", async () => {
  let calls = 0;
  await getJSON("https://quickbooks.api.intuit.com/test", {}, async () =>
    ++calls === 1
      ? new Response("", { status: 429 })
      : Response.json({ ok: true }),
  );
  assert.equal(calls, 2);
  await assert.rejects(
    getJSON(
      "https://quickbooks.api.intuit.com/test",
      {},
      async () => new Response("", { status: 401 }),
    ),
  );
  await assert.rejects(getJSON("https://attacker.example/data", {}));
});
test("rotating tokens are authenticated encrypted ciphertext", () => {
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
  const encrypted = encryptToken("sensitive-token");
  assert.ok(!encrypted.includes("sensitive-token"));
  assert.equal(decryptToken(encrypted), "sensitive-token");
  const tampered = Buffer.from(encrypted, "base64");
  tampered[30] ^= 1;
  assert.throws(() => decryptToken(tampered.toString("base64")));
});
