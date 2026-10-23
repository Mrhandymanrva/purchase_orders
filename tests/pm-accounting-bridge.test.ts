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

function qboQuery(call: Call) {
  return new URL(call.url).searchParams.get("query") || "";
}

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
      assert.equal(matched.result.truncated, false);
      assert.equal(
        qboQuery(calls[0]),
        "SELECT * FROM Bill WHERE VendorRef = '31' AND TxnDate >= '2026-01-15' AND TxnDate <= '2026-05-15' STARTPOSITION 1 MAXRESULTS 1000",
      );
      assert.equal(
        qboQuery(calls[1]),
        "SELECT * FROM Purchase WHERE TxnDate >= '2026-01-15' AND TxnDate <= '2026-05-15' STARTPOSITION 1 MAXRESULTS 1000",
      );
      assert.equal(qboQuery(calls[1]).includes("VendorRef"), false);

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

test("payables matches purchases with no vendor id and filters TotalAmt", async () => {
  await withBridge(
    async (url) => {
      const query = new URL(String(url)).searchParams.get("query") || "";
      if (query.startsWith("SELECT * FROM Bill"))
        return Response.json({
          QueryResponse: {
            Bill: [
              { Id: "b-low", TotalAmt: 19.99 },
              { Id: "b-min", TotalAmt: 20 },
              { Id: "b-mid", TotalAmt: 26.08 },
              { Id: "b-max", TotalAmt: 30 },
              { Id: "b-high", TotalAmt: 30.01 },
              { Id: "b-blank", PrivateNote: "missing total" },
            ],
          },
        });
      if (query.startsWith("SELECT * FROM Purchase"))
        return Response.json({
          QueryResponse: {
            Purchase: [
              {
                Id: "p-low",
                TotalAmt: 10,
                EntityRef: { value: "31", type: "Vendor" },
              },
              {
                Id: "p-hit",
                TotalAmt: 26.08,
                EntityRef: { value: "88", type: "Vendor" },
              },
              { Id: "p-card", TotalAmt: 26.08 },
              { Id: "p-high", TotalAmt: 80 },
            ],
          },
        });
      throw new Error("unexpected QuickBooks call " + query);
    },
    async (request, calls) => {
      const res = await request({
        action: "payables",
        from: "2026-10-01",
        to: "2026-10-31",
        minAmount: 20,
        maxAmount: 30,
      });
      assert.equal(res.status, 200);
      assert.equal(calls.length, 2);
      assertGetOnly(calls);
      assert.equal(qboQuery(calls[0]).includes("VendorRef"), false);
      assert.equal(qboQuery(calls[1]).includes("VendorRef"), false);
      assert.match(
        qboQuery(calls[0]),
        /SELECT \* FROM Bill WHERE TxnDate >= '2026-10-01' AND TxnDate <= '2026-10-31' /,
      );
      assert.match(
        qboQuery(calls[1]),
        /SELECT \* FROM Purchase WHERE TxnDate >= '2026-10-01' AND TxnDate <= '2026-10-31' /,
      );
      const body = await res.json();
      assert.equal(body.result.truncated, false);
      assert.deepEqual(
        body.result.bills.QueryResponse.Bill.map((row: { Id: string }) => row.Id),
        ["b-min", "b-mid", "b-max"],
      );
      assert.deepEqual(
        body.result.purchases.QueryResponse.Purchase.map(
          (row: { Id: string }) => row.Id,
        ),
        ["p-hit", "p-card"],
      );
      assert.deepEqual(body.result.purchases.QueryResponse.Purchase[0].EntityRef, {
        value: "88",
        type: "Vendor",
      });
      assert.equal(
        body.result.purchases.QueryResponse.Purchase[1].EntityRef,
        undefined,
      );

      calls.length = 0;
      const withVendor = await request({
        action: "payables",
        from: "2026-10-01",
        to: "2026-10-15",
        vendorId: "31",
      });
      assert.equal(withVendor.status, 200);
      assertGetOnly(calls);
      assert.match(qboQuery(calls[0]), /VendorRef = '31'/);
      assert.equal(qboQuery(calls[1]).includes("VendorRef"), false);
    },
  );
});

test("payables caps the window at 120 days and pages through the row cap", async () => {
  await withBridge(
    async (url) => {
      const query = new URL(String(url)).searchParams.get("query") || "";
      const start = Number(query.match(/STARTPOSITION (\d+)/)?.[1] || "0");
      if (query.includes("FROM Bill"))
        return Response.json({ QueryResponse: { Bill: [] } });
      if (!query.includes("FROM Purchase"))
        throw new Error("unexpected QuickBooks call " + query);
      if (query.includes("VendorRef"))
        throw new Error("purchase query must not filter VendorRef");
      if (start > 1001) throw new Error("paged past the cap at " + start);
      const count = start === 1 || start === 1001 ? 1000 : 0;
      return Response.json({
        QueryResponse: {
          Purchase: Array.from({ length: count }, (_, index) => ({
            Id: String(start + index),
            TotalAmt: start === 1 ? 5 : 26.08,
          })),
        },
      });
    },
    async (request, calls) => {
      const open = await request({ action: "payables", from: "2026-01-01" });
      assert.equal(open.status, 200);
      assertGetOnly(calls);
      const purchaseQueries = calls.filter((call) =>
        qboQuery(call).includes("FROM Purchase"),
      );
      assert.equal(purchaseQueries.length, 2);
      assert.match(
        qboQuery(purchaseQueries[0]),
        /TxnDate >= '2026-01-01' AND TxnDate <= '2026-05-01' STARTPOSITION 1 /,
      );
      assert.match(qboQuery(purchaseQueries[1]), /STARTPOSITION 1001 /);
      const openBody = await open.json();
      assert.equal(openBody.result.truncated, true);
      assert.equal(openBody.result.purchases.QueryResponse.Purchase.length, 2000);

      calls.length = 0;
      const bounded = await request({
        action: "payables",
        from: "2026-01-01",
        to: "2026-05-01",
        minAmount: 26.08,
        maxAmount: 26.08,
      });
      assert.equal(bounded.status, 200);
      assertGetOnly(calls);
      const boundedBody = await bounded.json();
      assert.equal(boundedBody.result.truncated, true);
      assert.equal(
        boundedBody.result.purchases.QueryResponse.Purchase.length,
        1000,
      );
      assert.ok(
        boundedBody.result.purchases.QueryResponse.Purchase.every(
          (row: { TotalAmt: number }) => row.TotalAmt === 26.08,
        ),
      );

      calls.length = 0;
      for (const body of [
        { action: "payables", from: "2026-01-01", to: "2026-05-02" },
        { action: "payables", from: "2026-05-02", to: "2026-01-01" },
      ]) {
        const res = await request(body);
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, "Invalid accounting request");
        assert.equal(calls.length, 0);
      }
    },
  );
});

test("payables zod rejects a bad request with Invalid accounting request", async () => {
  await withBridge(
    async () => {
      throw new Error("QuickBooks must not be called");
    },
    async (request, calls) => {
      for (const body of [
        { action: "payables" },
        { action: "payables", from: "yesterday" },
        { action: "payables", date: "01-15-2026" },
        { action: "payables", from: "2026-01-01", vendorId: "abc" },
        { action: "payables", from: "2026-01-01", minAmount: "20" },
        { action: "payables", from: "2026-01-01", minAmount: 30, maxAmount: 10 },
        { action: "payables", to: "2026-02-01" },
      ]) {
        const res = await request(body);
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, "Invalid accounting request");
        assert.equal(calls.length, 0);
      }
    },
  );
});
