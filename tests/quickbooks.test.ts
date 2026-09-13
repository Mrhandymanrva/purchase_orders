import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import {
  emptyState,
  readDB,
  persistDB,
  verifyAudit,
  type DB,
} from "../lib/store";
import {
  startQBOAuthorization,
  consumeQBOState,
  completeQBOConnection,
  qboSession,
  discoverQBOAccounts,
  applyQBOSelection,
  saveQBOSelection,
  cardDescendants,
  QuickBooksError,
  qboClientFingerprint,
  configuredQBO,
} from "../lib/quickbooks";
import { decryptToken, encryptToken } from "../lib/token-crypto";
import { readQBO, readIntegrationSetup } from "../lib/integrations";
import { POST as connect } from "../app/api/integrations/quickbooks/connect/route";
import { POST as accountsPost } from "../app/api/integrations/quickbooks/accounts/route";
import { GET as callback } from "../app/api/integrations/quickbooks/callback/route";
import { applyAction } from "../lib/actions";
import { planMappingImport } from "../lib/card-import";

const auth = {
  Authorization:
    "Basic " +
    Buffer.from("operator:long-test-password-for-qbo-only").toString("base64"),
  Origin: "https://app.example",
};
async function harness(run: (db: DB, pg: PGlite) => Promise<void>) {
  const old = { ...process.env };
  const globals = globalThis as unknown as { richmondPool?: unknown };
  const oldPool = globals.richmondPool;
  const pg = new PGlite();
  try {
    Object.assign(process.env, {
      NODE_ENV: "production",
      DEMO_MODE: "false",
      APP_ORIGIN: "https://app.example",
      APP_USER: "operator",
      APP_PASSWORD: "long-test-password-for-qbo-only",
      DATABASE_URL: "postgres://test-only",
      QBO_ENV: "production",
      QBO_CLIENT_ID: "test-client",
      QBO_CLIENT_SECRET: "test-secret",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    });
    for (const key of [
      "QBO_REALM_ID",
      "QBO_REFRESH_TOKEN",
      "QBO_CARD_ACCOUNT_IDS",
      "QBO_PARENT_CC_ACCOUNT_ID",
      "ST_CLIENT_ID",
    ])
      delete process.env[key];
    await pg.exec(
      await readFile(new URL("../db/001_initial.sql", import.meta.url), "utf8"),
    );
    await pg.query("INSERT INTO app_state(id,payload) VALUES(1,$1)", [
      JSON.stringify(emptyState()),
    ]);
    const db: DB = {
      query: async (sql, params) =>
        sql.includes("pg_advisory_xact_lock")
          ? { rows: [] }
          : await pg.query(sql, params),
    };
    globals.richmondPool = {
      ...db,
      connect: async () => ({ ...db, release() {} }),
    };
    await run(db, pg);
  } finally {
    globals.richmondPool = oldPool;
    for (const key of Object.keys(process.env))
      if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
    await pg.close();
  }
}
const provider: typeof fetch = async (url, init) => {
  if (String(url).includes("tokens/bearer")) {
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    const body = init?.body as URLSearchParams;
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(
      body.get("redirect_uri"),
      "https://app.example/api/integrations/quickbooks/callback",
    );
    return Response.json({
      access_token: "secret-access",
      refresh_token: "secret-refresh",
      expires_in: 3600,
    });
  }
  assert.equal(init?.method, "GET");
  assert.ok(String(url).includes("/company/12345/companyinfo/12345"));
  return Response.json({
    CompanyInfo: { Id: "1", CompanyName: "Test Richmond Company" },
  });
};

test("successful browser callback saves the company and a replay cannot exchange the code again", async () =>
  harness(async (db) => {
    const oldFetch = globalThis.fetch;
    try {
      let requests = 0;
      globalThis.fetch = async (...args) => {
        requests++;
        return provider(...args);
      };
      const response = await connect(
        new Request("https://app.example/api/integrations/quickbooks/connect", {
          method: "POST",
          headers: auth,
        }),
      );
      const cookie = response.headers.get("set-cookie")!.split(";")[0];
      const state = new URL((await response.json()).url).searchParams.get(
        "state",
      );
      const request = () =>
        new NextRequest(
          `https://app.example/api/integrations/quickbooks/callback?state=${state}&code=one-use-code&realmId=12345`,
          { headers: { cookie } },
        );
      const success = await callback(request());
      assert.ok(
        success.headers.get("location")?.includes("quickbooks=connected"),
      );
      assert.equal((await readDB(db)).quickbooks?.realm, "12345");
      assert.equal(requests, 2);
      const replay = await callback(request());
      assert.ok(replay.headers.get("location")?.includes("quickbooks=failed"));
      assert.equal(requests, 2);
    } finally {
      globalThis.fetch = oldFetch;
    }
  }));

test("connection metadata, tokens and audit all roll back when persistence fails", async () =>
  harness(async (db, pg) => {
    await pg.exec(
      "CREATE FUNCTION reject_connection_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test persistence failure'; END; $$; CREATE TRIGGER fail_connection_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_connection_audit();",
    );
    await assert.rejects(
      completeQBOConnection("12345", "code", "operator", provider),
      /test persistence failure/,
    );
    assert.equal((await db.query("SELECT * FROM oauth_tokens")).rows.length, 0);
    assert.equal((await readDB(db)).quickbooks, undefined);
    assert.equal((await readDB(db)).revision, 0);
  }));

test("OAuth state is hashed, browser-bound, expiring and single-use", async () =>
  harness(async (db) => {
    const start = await startQBOAuthorization("operator", db);
    const url = new URL(start.url),
      state = url.searchParams.get("state")!;
    assert.equal(url.origin, "https://appcenter.intuit.com");
    assert.equal(
      url.searchParams.get("scope"),
      "com.intuit.quickbooks.accounting",
    );
    assert.ok(!start.url.includes("test-secret"));
    const rows = await db.query("SELECT * FROM oauth_states");
    assert.ok(!JSON.stringify(rows).includes(state));
    assert.ok(!JSON.stringify(rows).includes(start.browser));
    await assert.rejects(
      consumeQBOState(state, "x".repeat(43), db),
      QuickBooksError,
    );
    assert.equal(await consumeQBOState(state, start.browser, db), "operator");
    await assert.rejects(
      consumeQBOState(state, start.browser, db),
      QuickBooksError,
    );
    const expired = await startQBOAuthorization("operator", db);
    await db.query(
      "UPDATE oauth_states SET expires_at=now()-interval '1 minute'",
    );
    await assert.rejects(
      consumeQBOState(
        new URL(expired.url).searchParams.get("state")!,
        expired.browser,
        db,
      ),
      QuickBooksError,
    );
  }));

test("OAuth state cannot cross environments or client apps", async () =>
  harness(async (db) => {
    const start = await startQBOAuthorization("operator", db),
      state = new URL(start.url).searchParams.get("state")!;
    process.env.QBO_ENV = "sandbox";
    await assert.rejects(
      consumeQBOState(state, start.browser, db),
      QuickBooksError,
    );
    process.env.QBO_ENV = "production";
    process.env.QBO_CLIENT_ID = "other-client";
    await assert.rejects(
      consumeQBOState(state, start.browser, db),
      QuickBooksError,
    );
  }));

test("company authorization persists encrypted rotating tokens and an audit, without manual realm or refresh env vars", async () =>
  harness(async (db) => {
    const prior = emptyState();
    prior.cardMappings = [
      {
        id: "existing-mapping",
        accountId: "81",
        cardUser: "Test Card User",
        from: "2026-09-01",
        reason: "Spreadsheet uploaded before connection",
      },
    ];
    await db.query("UPDATE app_state SET payload=$1 WHERE id=1", [
      JSON.stringify(prior),
    ]);
    await completeQBOConnection("12345", "one-use-code", "operator", provider);
    const state = await readDB(db);
    assert.deepEqual(state.cardMappings, prior.cardMappings);
    assert.equal(state.quickbooks?.realm, "12345");
    assert.equal(state.quickbooks?.companyName, "Test Richmond Company");
    assert.ok(verifyAudit(state.audit));
    assert.equal(state.audit[0].actor, "operator");
    assert.ok(!JSON.stringify(state).includes("secret-access"));
    assert.ok(!JSON.stringify(state).includes("secret-refresh"));
    const stored = (
      await db.query("SELECT payload FROM oauth_tokens WHERE provider='qbo'")
    ).rows[0].payload;
    assert.ok(!stored.includes("secret-refresh"));
    assert.equal(JSON.parse(decryptToken(stored)).realm, "12345");
    const session = await qboSession(async () => {
      throw Error("cached token should be used");
    });
    assert.equal(session.realm, "12345");
    assert.equal(session.accessToken, "secret-access");
    assert.deepEqual(session.accountIds, []);
    const setup = await readIntegrationSetup();
    for (const name of ["QBO_REALM_ID", "QBO_REFRESH_TOKEN"])
      assert.equal(
        setup.sources.flatMap((s) => s.checks).find((c) => c.setting === name)
          ?.configured,
        true,
      );
  }));

test("refresh rotation keeps company binding; provider failure preserves the existing connection", async () =>
  harness(async (db) => {
    await completeQBOConnection("12345", "code", "operator", provider);
    const row = (
      await db.query("SELECT payload FROM oauth_tokens WHERE provider='qbo'")
    ).rows[0];
    const expired = { ...JSON.parse(decryptToken(row.payload)), expiresAt: 0 };
    await db.query("UPDATE oauth_tokens SET payload=$1 WHERE provider='qbo'", [
      encryptToken(JSON.stringify(expired)),
    ]);
    const session = await qboSession(async (_url, init) => {
      assert.equal(
        (init?.body as URLSearchParams).get("grant_type"),
        "refresh_token",
      );
      return Response.json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      });
    });
    assert.equal(session.accessToken, "rotated-access");
    const current = (
      await db.query("SELECT payload FROM oauth_tokens WHERE provider='qbo'")
    ).rows[0].payload;
    const payload = JSON.parse(decryptToken(current));
    assert.equal(payload.refreshToken, "rotated-refresh");
    assert.equal(payload.realm, "12345");
    assert.equal(payload.environment, "production");
    const before = await readDB(db);
    await assert.rejects(
      completeQBOConnection(
        "12345",
        "bad-code",
        "operator",
        async () => new Response("do-not-leak-provider-body", { status: 400 }),
      ),
      (e: Error) => !e.message.includes("do-not-leak"),
    );
    assert.deepEqual(await readDB(db), before);
    assert.equal(
      (await db.query("SELECT payload FROM oauth_tokens WHERE provider='qbo'"))
        .rows[0].payload,
      current,
    );
  }));

test("another company cannot replace a workspace connection and app changes cannot reuse its token", async () =>
  harness(async (db) => {
    await completeQBOConnection("12345", "code", "operator", provider);
    let requests = 0;
    await assert.rejects(
      completeQBOConnection("67890", "code", "operator", async () => {
        requests++;
        throw Error("no request expected");
      }),
      QuickBooksError,
    );
    assert.equal(requests, 0);
    process.env.QBO_ENV = "sandbox";
    await assert.rejects(qboSession(), QuickBooksError);
    assert.equal((await readDB(db)).quickbooks?.realm, "12345");
  }));

const cardRows = [
  {
    Id: "main",
    Name: "Company Visa",
    AccountType: "Credit Card",
    Active: true,
    SubAccount: false,
  },
  {
    Id: "81",
    Name: "Alex",
    AccountType: "Credit Card",
    Active: true,
    SubAccount: true,
    ParentRef: { value: "main" },
  },
  {
    Id: "82",
    Name: "Chris",
    AccountType: "Credit Card",
    Active: true,
    SubAccount: true,
    ParentRef: { value: "main" },
  },
  {
    Id: "83",
    Name: "Closed",
    AccountType: "Credit Card",
    Active: false,
    SubAccount: true,
    ParentRef: { value: "main" },
  },
  {
    Id: "other",
    Name: "Other parent",
    AccountType: "Credit Card",
    Active: true,
    SubAccount: false,
  },
  {
    Id: "99",
    Name: "Other card",
    AccountType: "Credit Card",
    Active: true,
    SubAccount: true,
    ParentRef: { value: "other" },
  },
  { Id: "bank", Name: "Bank", AccountType: "Bank", Active: true },
];
test("card discovery works without ST credentials and scoped selection is audited and rejects unknown, parent and unrelated accounts", async () =>
  harness(async (db) => {
    await completeQBOConnection("12345", "code", "operator", provider);
    const discovered = await discoverQBOAccounts(
      1,
      "operator",
      async (_url, init) => {
        assert.equal(init?.method, "GET");
        return Response.json({ QueryResponse: { Account: cardRows } });
      },
    );
    assert.equal(discovered.quickbooks?.accounts.length, 6);
    const selection = {
      revision: discovered.revision,
      parentAccountId: "main",
      accountIds: ["81", "82"],
      reason: "Richmond employee cards",
    };
    for (const id of ["main", "unknown", "99", "83"])
      assert.throws(
        () =>
          applyQBOSelection(
            structuredClone(discovered),
            { ...selection, accountIds: [id] },
            "operator",
          ),
        QuickBooksError,
      );
    const saved = await saveQBOSelection(selection, "operator");
    assert.deepEqual(configuredQBO(saved).accountIds, ["81", "82"]);
    assert.ok(
      saved.directory?.accounts.every((a) => a.id !== "main" && a.id !== "99"),
    );
    assert.deepEqual(saved.records, discovered.records);
    assert.equal(
      saved.audit.at(-1)?.action,
      "QuickBooks purchase account scope saved",
    );
    assert.ok(verifyAudit(saved.audit));
    await assert.rejects(
      saveQBOSelection(selection, "operator"),
      /Workspace changed/,
    );
    const withParent = {
      ...saved,
      directory: {
        ...saved.directory!,
        accounts: [
          ...saved.directory!.accounts,
          { id: "main", name: "Parent", active: true },
        ],
      },
    };
    assert.throws(
      () =>
        applyAction(
          withParent,
          {
            type: "save-card-mapping",
            revision: saved.revision,
            mapping: {
              accountId: "main",
              cardUser: "Test User",
              reason: "test mapping",
            },
          },
          "operator",
        ),
      /parent/,
    );
    const plan = planMappingImport(
      saved,
      [
        {
          row: 2,
          accountId: "main",
          cardUser: "Test User",
          from: "2026-09-01",
        },
      ],
      "test",
      saved.quickbooks?.parentAccountId,
    );
    assert.ok(plan.errors.length > 0);
  }));

test("saved child selection overrides the legacy env allowlist and excludes parent balances", async () => {
  const old = process.env.QBO_CARD_ACCOUNT_IDS;
  process.env.QBO_CARD_ACCOUNT_IDS = "main,99";
  try {
    const rows = await readQBO(
      "token",
      "12345",
      "2026-09-01",
      "2026-09-13",
      async () =>
        Response.json({
          QueryResponse: {
            Purchase: ["main", "81", "99"].map((id) => ({
              Id: id,
              PaymentType: "CreditCard",
              TotalAmt: 10,
              TxnDate: "2026-09-01",
              AccountRef: { value: id },
              EntityRef: { value: "v", name: "Vendor" },
            })),
          },
        }),
      ["81"],
    );
    assert.deepEqual(
      rows.map((r) => r.accountId),
      ["81"],
    );
    await assert.rejects(
      readQBO(
        "token",
        "12345",
        "2026-09-01",
        "2026-09-13",
        async () => {
          throw Error("should not fetch");
        },
        [],
      ),
      QuickBooksError,
    );
  } finally {
    if (old === undefined) delete process.env.QBO_CARD_ACCOUNT_IDS;
    else process.env.QBO_CARD_ACCOUNT_IDS = old;
  }
});

test("OAuth routes enforce origin/auth, secure cookies, and fail-closed callbacks without leaking query values", async () =>
  harness(async (db) => {
    assert.equal(
      (
        await connect(
          new Request(
            "https://app.example/api/integrations/quickbooks/connect",
            { method: "POST" },
          ),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await accountsPost(
          new Request(
            "https://app.example/api/integrations/quickbooks/accounts",
            {
              method: "POST",
              headers: { ...auth, Origin: "https://evil.example" },
            },
          ),
        )
      ).status,
      403,
    );
    const response = await connect(
      new Request("https://app.example/api/integrations/quickbooks/connect", {
        method: "POST",
        headers: auth,
      }),
    );
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")!;
    for (const flag of ["HttpOnly", "Secure", "SameSite=lax", "Path=/"])
      assert.ok(cookie.includes(flag));
    const start = await response.json(),
      state = new URL(start.url).searchParams.get("state");
    const denied = await callback(
      new NextRequest(
        `https://app.example/api/integrations/quickbooks/callback?state=${state}&error=access_denied`,
        { headers: { cookie: cookie.split(";")[0] } },
      ),
    );
    assert.equal(denied.status, 303);
    assert.ok(denied.headers.get("location")?.includes("quickbooks=denied"));
    const invalid = await callback(
      new NextRequest(
        "https://app.example/api/integrations/quickbooks/callback?state=bad&code=secret-code&realmId=12345",
      ),
    );
    assert.equal(invalid.status, 303);
    assert.ok(!invalid.headers.get("location")?.includes("secret-code"));
    assert.equal(invalid.headers.get("referrer-policy"), "no-referrer");
    assert.equal((await readDB(db)).quickbooks, undefined);
  }));
