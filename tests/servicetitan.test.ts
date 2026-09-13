import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  mapSTPeople,
  readDirectories,
  fetchSTBusinessUnits,
  readST,
  readIntegrationSetup,
} from "../lib/integrations";
import { configuredST } from "../lib/servicetitan-settings";
import { applyAction } from "../lib/actions";
import { emptyState, readDB, verifyAudit, type DB } from "../lib/store";
import { resolvePerson } from "../lib/directory";
import { seed } from "../lib/seed";
import { POST } from "../app/api/actions/route";

const stEnv = {
  ST_ENV: "production",
  ST_TENANT_ID: "test-tenant",
  ST_CLIENT_ID: "test-client",
  ST_CLIENT_SECRET: "test-secret",
  ST_APP_KEY: "test-app-key",
};
async function withEnv(run: () => Promise<void>) {
  const old = { ...process.env };
  try {
    Object.assign(process.env, stEnv);
    await run();
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
}
const units = {
  tenantId: "test-tenant",
  environment: "production" as const,
  discoveredAt: "2026-09-13T12:00:00Z",
  businessUnits: [
    { id: "r", name: "Richmond", active: true },
    { id: "h", name: "Hampton", active: true },
    { id: "old", name: "Retired unit", active: false },
  ],
};

test("only active ST people are retained, including when inactive employees have blank names", () => {
  const people = mapSTPeople(
    [
      { id: 1, name: "  Alex  ", active: true, email: "discard@example.com" },
      { id: 2, name: "", active: false },
      { id: 3, name: null, active: false },
      { id: 4, name: "Former employee", active: false },
    ],
    "employee",
  );
  assert.deepEqual(people, [
    {
      id: "employee:1",
      sourceId: "1",
      name: "Alex",
      active: true,
      kind: "employee",
    },
  ]);
  assert.equal(
    mapSTPeople([{ id: 1, name: "Alex", active: true }], "technician")[0].id,
    "technician:1",
  );
});

test("active unnamed people and duplicate ST identities still fail closed", () => {
  for (const name of ["", "  ", null, undefined, 123])
    assert.throws(
      () => mapSTPeople([{ id: 1, name, active: true }], "employee"),
      /Active ServiceTitan employee #1 has no usable name/,
    );
  assert.throws(
    () =>
      mapSTPeople(
        [
          { id: 1, name: "", active: false },
          { id: 1, name: "Alex", active: true },
        ],
        "employee",
      ),
    /duplicate employee IDs/,
  );
  assert.throws(() =>
    mapSTPeople([{ name: "Alex", active: true }], "employee"),
  );
});

test("directory refresh requests active ST people and retains saved assignment history", async () =>
  withEnv(async () => {
    const mock: typeof fetch = async (url, init) => {
      assert.equal(init?.method, "GET");
      const u = new URL(String(url));
      if (u.pathname.endsWith("/query"))
        return Response.json({
          QueryResponse: {
            Account: [
              {
                Id: "card",
                Name: "Card",
                Active: true,
                AccountType: "Credit Card",
                SubAccount: true,
                ParentRef: { value: "parent" },
              },
            ],
          },
        });
      if (u.pathname.endsWith("/purchase-order-types"))
        return Response.json({
          data: [{ id: 2, name: "Van Stock", active: true }],
          hasMore: false,
        });
      assert.equal(u.searchParams.get("active"), "True");
      return Response.json({
        data: [
          { id: 1, name: "Alex", active: true },
          { id: 9, name: "", active: false },
        ],
        hasMore: false,
      });
    };
    const directory = await readDirectories("st", "qb", "realm", mock, {
      parentAccountId: "parent",
      accountIds: ["card"],
    });
    assert.equal(directory.people.length, 2);
    assert.ok(directory.people.every((p) => p.active));
    const s = seed();
    const prior = {
      id: "historical",
      accountId: "card",
      personId: "employee:9",
      cardUser: "Former employee",
      from: "2026-01-01",
      through: "2026-08-31",
      reason: "Historical assignment",
    };
    s.cardMappings = [prior];
    const before = structuredClone(s.records);
    applyAction(
      s,
      { type: "refresh-directory", revision: s.revision },
      "operator",
      undefined,
      directory,
    );
    assert.deepEqual(s.cardMappings, [prior]);
    assert.deepEqual(s.records, before);
    assert.deepEqual(resolvePerson(s, prior.cardUser, prior.personId, prior), {
      cardUser: prior.cardUser,
      personId: prior.personId,
    });
    assert.throws(
      () => resolvePerson(s, prior.cardUser, prior.personId),
      /not found/,
    );
    assert.ok(verifyAudit(s.audit));
  }));

test("business unit discovery uses ST only and returns names without extra metadata", async () =>
  withEnv(async () => {
    for (const key of Object.keys(process.env))
      if (key.startsWith("QBO_")) delete process.env[key];
    const result = await fetchSTBusinessUnits(async (url, init) => {
      const u = new URL(String(url));
      if (u.hostname === "auth.servicetitan.io") {
        assert.equal(init?.method, "POST");
        return Response.json({ access_token: "test-token" });
      }
      assert.equal(init?.method, "GET");
      assert.equal(
        u.pathname,
        "/settings/v2/tenant/test-tenant/business-units",
      );
      return Response.json({
        data: units.businessUnits.map((u) => ({
          ...u,
          address: "discard this",
        })),
        hasMore: false,
      });
    });
    assert.deepEqual(result.businessUnits, units.businessUnits);
    assert.equal(result.environment, "production");
    assert.equal(result.tenantId, "test-tenant");
  }));

test("business unit selection validates scope and audits it without replacing financial records", () => {
  const s = seed();
  s.serviceTitan = structuredClone(units);
  const before = structuredClone(s.records);
  const save = {
    type: "save-st-business-units" as const,
    revision: s.revision,
    reason: "Richmond purchases only",
    businessUnitIds: ["r"],
  };
  for (const businessUnitIds of [[], ["unknown"], ["old"], ["r", "r"]]) {
    const unchanged = structuredClone(s);
    assert.throws(
      () => applyAction(s, { ...save, businessUnitIds }, "operator"),
      /active ServiceTitan/,
    );
    assert.deepEqual(s, unchanged);
  }
  applyAction(s, save, "operator");
  assert.deepEqual(s.serviceTitan.businessUnitIds, ["r"]);
  assert.deepEqual(s.records, before);
  assert.deepEqual((s.audit.at(-1)!.detail as any).after, [
    { id: "r", name: "Richmond" },
  ]);
  assert.ok(verifyAudit(s.audit));
});

test("saved scope overrides legacy variables and is bound to the tenant and environment", async () =>
  withEnv(async () => {
    process.env.ST_BUSINESS_UNIT_IDS = "h";
    const s = emptyState();
    s.serviceTitan = { ...units, businessUnitIds: ["r"] };
    assert.deepEqual(configuredST(s).businessUnitIds, ["r"]);
    assert.deepEqual(configuredST().businessUnitIds, ["h"]);
    process.env.ST_TENANT_ID = "other-tenant";
    assert.throws(() => configuredST(s), /tenant or environment changed/);
    process.env.ST_TENANT_ID = "test-tenant";
    process.env.ST_ENV = "integration";
    assert.throws(() => configuredST(s), /tenant or environment changed/);
  }));

test("PO adapter imports only the explicitly selected business units", async () =>
  withEnv(async () => {
    process.env.ST_BUSINESS_UNIT_IDS = "h";
    const records = await readST(
      "st",
      "2026-09-01",
      "2026-09-13",
      async (url, init) => {
        assert.equal(init?.method, "GET");
        if (String(url).includes("/vendors?"))
          return Response.json({
            data: [{ id: 1, name: "Vendor" }],
            hasMore: false,
          });
        return Response.json({
          data: ["r", "h", null, undefined].map((businessUnitId, index) => ({
            id: index + 1,
            vendorId: 1,
            number: "PO-" + index,
            date: "2026-09-05",
            createdOn: "2026-09-05",
            total: 10,
            status: "Sent",
            businessUnitId,
          })),
          hasMore: false,
        });
      },
      ["r"],
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].account, "r");
    let calls = 0;
    await assert.rejects(
      readST(
        "st",
        "2026-09-01",
        "2026-09-13",
        async () => {
          calls++;
          throw Error("unexpected");
        },
        [],
      ),
      /Choose the ServiceTitan/,
    );
    assert.equal(calls, 0);
  }));

test("ST scope API enforces auth, persists selection in PostgreSQL, reports readiness and rejects stale saves", async () =>
  withEnv(async () => {
    const globals = globalThis as unknown as { richmondPool?: unknown };
    const oldPool = globals.richmondPool,
      oldFetch = globalThis.fetch;
    const pg = new PGlite();
    try {
      Object.assign(process.env, {
        NODE_ENV: "production",
        DEMO_MODE: "false",
        DATABASE_URL: "postgres://test-only",
        APP_ORIGIN: "https://app.example",
        APP_USER: "operator",
        APP_PASSWORD: "long-test-password-for-st-setup",
        ST_BUSINESS_UNIT_IDS: "",
      });
      await pg.exec(
        await readFile(
          new URL("../db/001_initial.sql", import.meta.url),
          "utf8",
        ),
      );
      await pg.query("INSERT INTO app_state(id,payload) VALUES(1,$1)", [
        JSON.stringify(emptyState()),
      ]);
      const db: DB = {
        query: async (sql, params) => await pg.query(sql, params),
      };
      globals.richmondPool = {
        ...db,
        connect: async () => ({ ...db, release() {} }),
      };
      let calls = 0;
      globalThis.fetch = async (url, init) => {
        calls++;
        if (String(url).includes("/connect/token"))
          return Response.json({ access_token: "fake-token" });
        assert.equal(init?.method, "GET");
        assert.ok(String(url).includes("/business-units?"));
        return Response.json({ data: units.businessUnits, hasMore: false });
      };
      const headers = {
        Authorization:
          "Basic " +
          Buffer.from("operator:long-test-password-for-st-setup").toString(
            "base64",
          ),
        Origin: "https://app.example",
        "Content-Type": "application/json",
      };
      const send = (body: object, requestHeaders = headers) =>
        POST(
          new Request("https://app.example/api/actions", {
            method: "POST",
            headers: requestHeaders,
            body: JSON.stringify(body),
          }),
        );
      const discover = { type: "discover-st-business-units", revision: 0 };
      assert.equal(
        (await send(discover, { ...headers, Authorization: "" })).status,
        403,
      );
      assert.equal(
        (await send(discover, { ...headers, Origin: "https://other.example" }))
          .status,
        403,
      );
      assert.equal(calls, 0);
      const loaded = await send(discover);
      assert.equal(loaded.status, 200);
      assert.equal((await readDB(db)).serviceTitan?.businessUnits.length, 3);
      const save = {
        type: "save-st-business-units",
        revision: 1,
        businessUnitIds: ["r"],
        reason: "Initial Richmond PO scope",
      };
      assert.equal(
        (await send({ ...save, businessUnitIds: ["old"] })).status,
        400,
      );
      assert.equal((await readDB(db)).revision, 1);
      assert.equal((await send(save)).status, 200);
      const saved = await readDB(db);
      assert.deepEqual(saved.serviceTitan?.businessUnitIds, ["r"]);
      assert.equal(saved.audit.length, 2);
      assert.ok(verifyAudit(saved.audit));
      assert.equal((await send(save)).status, 409);
      const setup = await readIntegrationSetup();
      assert.equal(
        setup.sources
          .find((s) => s.name === "ServiceTitan")!
          .checks.find((c) => c.setting === "ST_BUSINESS_UNIT_IDS")!.configured,
        true,
      );
    } finally {
      globalThis.fetch = oldFetch;
      globals.richmondPool = oldPool;
      await pg.close();
    }
  }));
