import { test } from "node:test";
import assert from "node:assert/strict";
import {
  integrationSetup,
  IntegrationSetupError,
} from "../lib/integration-setup";
import {
  fetchSnapshot,
  fetchDirectories,
  readQBAccounts,
} from "../lib/integrations";
import { GET } from "../app/api/integrations/status/route";

const complete = {
  ST_ENV: "production",
  ST_TENANT_ID: "tenant-test",
  ST_CLIENT_ID: "st-client-test",
  ST_CLIENT_SECRET: "never-return-this-st-secret",
  ST_APP_KEY: "never-return-this-app-key",
  ST_BUSINESS_UNIT_IDS: "1,2",
  QBO_ENV: "production",
  QBO_CLIENT_ID: "qb-client-test",
  QBO_CLIENT_SECRET: "never-return-this-qb-secret",
  QBO_REALM_ID: "realm-test",
  QBO_REFRESH_TOKEN: "never-return-this-refresh-token",
  QBO_CARD_ACCOUNT_IDS: "81,82",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  SYNC_FROM: "2026-09-01",
};
const restoreEnv = (old: NodeJS.ProcessEnv) => {
  for (const key of Object.keys(process.env))
    if (!(key in old)) delete process.env[key];
  Object.assign(process.env, old);
};

test("setup reports all missing fields and never exposes configured credentials", () => {
  const empty = integrationSetup({}, false, "2026-09-13");
  assert.equal(empty.syncReady, false);
  assert.equal(empty.directoryReady, false);
  const failure = new IntegrationSetupError(empty, "sync");
  for (const key of ["ST_CLIENT_ID", "ST_APP_KEY"])
    assert.ok(failure.message.includes(key));
  assert.ok(failure.message.includes("Connect QuickBooks"));
  const good = integrationSetup(complete, false, "2026-09-13");
  assert.equal(good.syncReady, true);
  assert.equal(good.directoryReady, true);
  for (const value of Object.values(complete))
    assert.ok(!JSON.stringify(good).includes(value));
});

test("a persisted OAuth token satisfies setup without the bootstrap refresh token", () => {
  assert.equal(
    integrationSetup({ ...complete, QBO_REFRESH_TOKEN: "" }, true, "2026-09-13")
      .syncReady,
    true,
  );
  assert.equal(
    integrationSetup(
      { ...complete, QBO_REFRESH_TOKEN: "" },
      false,
      "2026-09-13",
    ).directoryReady,
    false,
  );
});

test("parent-only discovery works before child allowlist and purchase scopes are configured", () => {
  const setup = integrationSetup(
    {
      ...complete,
      QBO_CARD_ACCOUNT_IDS: "",
      QBO_PARENT_CC_ACCOUNT_ID: "parent",
      ST_BUSINESS_UNIT_IDS: "",
      SYNC_FROM: "",
    },
    false,
    "2026-09-13",
  );
  assert.equal(setup.directoryReady, true);
  assert.equal(setup.syncReady, false);
  assert.ok(
    !new IntegrationSetupError(setup, "directory").message.includes(
      "ST_BUSINESS_UNIT_IDS",
    ),
  );
});

test("invalid environments, blank lists, encryption keys and impossible or future dates fail setup", () => {
  for (const changes of [
    { ST_ENV: "prod" },
    { QBO_ENV: "testing" },
    { ST_CLIENT_ID: "  " },
    { QBO_CARD_ACCOUNT_IDS: " , " },
    { TOKEN_ENCRYPTION_KEY: "short" },
    { SYNC_FROM: "2026-02-30" },
    { SYNC_FROM: "2026-09-14" },
  ]) {
    assert.equal(
      integrationSetup({ ...complete, ...changes }, false, "2026-09-13")
        .syncReady,
      false,
    );
  }
});

test("incomplete setup stops both sync paths before any external requests", async () => {
  const old = { ...process.env };
  try {
    for (const key of [
      ...Object.keys(complete),
      "QBO_PARENT_CC_ACCOUNT_ID",
      "DATABASE_URL",
    ])
      delete process.env[key];
    let requests = 0;
    const fetcher: typeof fetch = async () => {
      requests++;
      throw Error("must not contact provider");
    };
    await assert.rejects(fetchSnapshot(fetcher), IntegrationSetupError);
    await assert.rejects(fetchDirectories(fetcher), IntegrationSetupError);
    assert.equal(requests, 0);
  } finally {
    restoreEnv(old);
  }
});

test("parent-only QuickBooks discovery excludes the parent and unrelated cards", async () => {
  const old = { ...process.env };
  try {
    process.env.QBO_PARENT_CC_ACCOUNT_ID = "parent";
    delete process.env.QBO_CARD_ACCOUNT_IDS;
    const account = (Id: string, parent?: string) => ({
      Id,
      Name: Id,
      AccountType: "Credit Card",
      Active: true,
      SubAccount: Boolean(parent),
      ...(parent ? { ParentRef: { value: parent } } : {}),
    });
    const rows = await readQBAccounts(
      "fake-token",
      "fake-realm",
      async (_url, init) => {
        assert.equal(init?.method, "GET");
        return Response.json({
          QueryResponse: {
            Account: [
              account("parent"),
              account("81", "parent"),
              account("82", "81"),
              account("99", "other"),
            ],
          },
        });
      },
    );
    assert.deepEqual(
      rows.map((r) => r.id),
      ["81", "82"],
    );
  } finally {
    restoreEnv(old);
  }
});

test("status endpoint requires authentication and returns only safe no-store diagnostics", async () => {
  const old = { ...process.env };
  try {
    Object.assign(process.env, complete, {
      NODE_ENV: "production",
      DEMO_MODE: "false",
      APP_USER: "operator",
      APP_PASSWORD: "long-test-password-for-setup-only",
    });
    assert.equal(
      (await GET(new Request("https://app.example/api/integrations/status")))
        .status,
      401,
    );
    const response = await GET(
      new Request("https://app.example/api/integrations/status", {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from("operator:long-test-password-for-setup-only").toString(
              "base64",
            ),
        },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const content = await response.text();
    for (const key of [
      "ST_CLIENT_SECRET",
      "ST_APP_KEY",
      "QBO_CLIENT_SECRET",
      "QBO_REFRESH_TOKEN",
      "TOKEN_ENCRYPTION_KEY",
    ] as const)
      assert.ok(!content.includes(complete[key]));
    assert.equal(JSON.parse(content).setup.directoryReady, true);
  } finally {
    restoreEnv(old);
  }
});
