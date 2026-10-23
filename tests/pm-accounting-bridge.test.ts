import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/pm-accounting/route";
import { encryptToken } from "../lib/token-crypto";

const headers = {
  Authorization:
    "Basic " +
    Buffer.from("pm-test:long-test-password-for-bridge").toString("base64"),
  "x-pm-accounting-key": "k".repeat(48),
  "Content-Type": "application/json",
};
const requestId = "12345678-1234-4234-8234-123456789012";

type Call = { url: string; method: string; body?: string };

function line(amount: number, n = 0) {
  return {
    Amount: amount,
    Description: "Cost " + n,
    DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: {
      AccountRef: { value: "7" },
      CustomerRef: { value: "8" },
      BillableStatus: "NotBillable",
    },
  };
}

function bill(
  lines: ReturnType<typeof line>[],
  expectedRealm?: string,
) {
  return {
    action: "createBill" as const,
    requestId,
    ...(expectedRealm ? { expectedRealm } : {}),
    payload: {
      VendorRef: { value: "31" },
      DocNumber: "INV-1",
      TxnDate: "2026-10-01",
      DueDate: "2026-10-31",
      PrivateNote: "Journeyman PM bill test",
      Line: lines,
    },
  };
}

function assertGetOnly(calls: Call[]) {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.method, "GET");
    assert.equal(call.body, undefined);
    assert.equal(call.url.includes("requestid="), false);
    assert.equal(call.url.includes("/upload"), false);
    assert.ok(
      call.url.startsWith(
        "https://sandbox-quickbooks.api.intuit.com/v3/company/123/",
      ),
    );
  }
}

async function withBridge(
  fetchImpl: typeof fetch,
  run: (request: (body: unknown) => Promise<Response>, calls: Call[]) => Promise<void>,
) {
  const old = { ...process.env };
  const globals = globalThis as unknown as { richmondPool?: unknown };
  const oldPool = globals.richmondPool;
  const oldFetch = globalThis.fetch;
  const calls: Call[] = [];
  try {
    Object.assign(process.env, {
      NODE_ENV: "production",
      DEMO_MODE: "false",
      APP_USER: "pm-test",
      APP_PASSWORD: "long-test-password-for-bridge",
      PM_ACCOUNTING_KEY: "k".repeat(48),
      DATABASE_URL: "postgres://test-only",
      QBO_ENV: "sandbox",
      QBO_CLIENT_ID: "test-client",
      QBO_REALM_ID: "123",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    });
    const query = async (sql: string) => ({
      rows: sql.includes("app_state")
        ? [{ payload: { revision: 0 } }]
        : sql.includes("oauth_tokens")
          ? [
              {
                payload: encryptToken(
                  JSON.stringify({
                    accessToken: "test-access",
                    expiresAt: Date.now() + 3600000,
                  }),
                ),
              },
            ]
          : [],
    });
    globals.richmondPool = {
      query,
      connect: async () => ({ query, release() {} }),
    };
    globalThis.fetch = (async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method || "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return fetchImpl(url, init);
    }) as typeof fetch;
    const request = (body: unknown) =>
      POST(
        new Request("https://app.example/api/pm-accounting", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      );
    await run(request, calls);
  } finally {
    globalThis.fetch = oldFetch;
    globals.richmondPool = oldPool;
    for (const key of Object.keys(process.env))
      if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
}

test("bill schema accepts 1-25 positive lines and rejects 0 lines and negative amounts", async () => {
  await withBridge(
    async (_url, init) => {
      assert.equal(init?.method, "POST");
      return Response.json({ Bill: { Id: "55" } });
    },
    async (request, calls) => {
      for (const count of [1, 25]) {
        calls.length = 0;
        const amounts = Array.from({ length: count }, (_, i) =>
          i === 0 ? 0.01 : i + 1,
        );
        const res = await request(
          bill(
            amounts.map((amount, i) => line(amount, i)),
            "123",
          ),
        );
        assert.equal(res.status, 200);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, "POST");
        assert.match(calls[0].url, /\/bill\?requestid=/);
        const sent = JSON.parse(calls[0].body || "{}");
        assert.equal(sent.Line.length, count);
        assert.ok(
          sent.Line.every((row: { Amount: number }) => row.Amount > 0),
        );
      }

      calls.length = 0;
      const rejected = [
        [],
        [line(-1)],
        [line(10), line(-0.01, 1)],
        [line(0)],
        Array.from({ length: 26 }, (_, i) => line(1, i)),
      ];
      for (const lines of rejected) {
        const res = await request(bill(lines, "123"));
        assert.equal(res.status, 400);
        assert.equal(
          (await res.json()).error,
          "Invalid accounting request",
        );
        assert.equal(calls.length, 0);
      }

      const unbound = await request(bill([line(10)]));
      assert.equal(unbound.status, 400);
      assert.equal(
        (await unbound.json()).error,
        "Company binding required for writes",
      );
      assert.equal(calls.length, 0);
    },
  );
});

test("purchase and payables read QuickBooks with GET only", async () => {
  await withBridge(
    async (url) => {
      const query = new URL(String(url)).searchParams.get("query") || "";
      if (query.startsWith("SELECT * FROM Bill"))
        return Response.json({
          QueryResponse: { Bill: [{ Id: "b1", TotalAmt: 10 }] },
        });
      if (query.startsWith("SELECT * FROM Purchase"))
        return Response.json({
          QueryResponse: { Purchase: [{ Id: "p1", TotalAmt: 12 }] },
        });
      if (String(url).includes("/purchase/99"))
        return Response.json({ Purchase: { Id: "99", TotalAmt: 12.5 } });
      throw new Error("unexpected QuickBooks call " + String(url));
    },
    async (request, calls) => {
      const purchase = await request({ action: "purchase", id: "99" });
      assert.equal(purchase.status, 200);
      assert.equal((await purchase.json()).result.Purchase.Id, "99");
      assert.equal(calls.length, 1);
      assertGetOnly(calls);
      assert.match(calls[0].url, /\/purchase\/99\?minorversion=75$/);

      calls.length = 0;
      const payables = await request({
        action: "payables",
        vendorId: "31",
        date: "2026-01-15",
      });
      assert.equal(payables.status, 200);
      const matched = await payables.json();
      assert.equal(matched.result.bills.QueryResponse.Bill[0].Id, "b1");
      assert.equal(
        matched.result.purchases.QueryResponse.Purchase[0].Id,
        "p1",
      );
      assert.equal(calls.length, 2);
      assertGetOnly(calls);
      assert.equal(
        new URL(calls[0].url).searchParams.get("query"),
        "SELECT * FROM Bill WHERE VendorRef = '31' AND TxnDate >= '2026-01-15' MAXRESULTS 1000",
      );
      assert.equal(
        new URL(calls[1].url).searchParams.get("query"),
        "SELECT * FROM Purchase WHERE VendorRef = '31' AND TxnDate >= '2026-01-15' MAXRESULTS 1000",
      );

      calls.length = 0;
      for (const body of [
        { action: "createPurchase", id: "99" },
        { action: "purchase" },
        { action: "payables", vendorId: "31", date: "yesterday" },
        { action: "payables", vendorId: "abc", date: "2026-01-15" },
      ]) {
        const res = await request(body);
        assert.equal(res.status, 400);
        assert.equal(calls.length, 0);
      }
    },
  );

  await withBridge(
    async (_url, init) => {
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      throw new Error("offline");
    },
    async (request) => {
      for (const body of [
        { action: "purchase", id: "99" },
        { action: "payables", vendorId: "31", date: "2026-01-15" },
      ]) {
        const res = await request(body);
        assert.equal(res.status, 503);
        const json = await res.json();
        assert.equal(json.uncertain, false);
        assert.equal(json.error, "QuickBooks connection unavailable.");
      }
    },
  );
});
