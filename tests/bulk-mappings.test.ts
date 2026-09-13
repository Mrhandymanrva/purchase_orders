import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { seed } from "../lib/seed";
import { actionSchema, applyAction } from "../lib/actions";
import { readDB, verifyAudit, type DB } from "../lib/store";
import { POST } from "../app/api/actions/route";

const row = (accountId = "demo-81", fields: object = {}) => ({
  accountId,
  cardUser: "Alex Morgan",
  personId: "technician:demo-1",
  from: "2026-09-01",
  ...fields,
});
const batch = (mappings: object[], revision = 1) =>
  actionSchema.parse({ type: "save-card-mappings", revision, mappings });

test("save all imports 25 assignments without reasons and audits before/after ownership", () => {
  const s = seed();
  s.directory!.accounts.push(
    ...Array.from({ length: 25 }, (_, i) => ({
      id: `extra-${i}`,
      name: `Card ${i}`,
      active: true,
    })),
  );
  applyAction(
    s,
    batch(Array.from({ length: 25 }, (_, i) => row(`extra-${i}`))),
    "operator",
  );
  assert.equal(s.cardMappings?.length, 25);
  assert.ok(
    s.cardMappings?.every(
      (m) => m.reason === "Saved from card assignment grid",
    ),
  );
  const detail = s.audit.at(-1)!.detail as any;
  assert.equal(detail.count, 25);
  assert.equal(detail.changes.length, 25);
  assert.equal(s.audit.at(-1)!.actor, "operator");
  assert.ok(verifyAudit(s.audit));
});

test("bulk validation is atomic for unknown people, unknown accounts, duplicate edits and overlapping periods", () => {
  const s = seed();
  applyAction(
    s,
    actionSchema.parse({
      type: "save-card-mapping",
      revision: 1,
      mapping: row(),
    }),
    "operator",
  );
  const saved = s.cardMappings![0];
  for (const invalid of [
    [row("demo-82"), row("demo-83", { personId: "technician:missing" })],
    [row("demo-82"), row("unknown")],
    [
      { ...saved, through: "2026-09-05" },
      { ...saved, through: "2026-09-06" },
    ],
    [row("demo-82"), row("demo-82", { from: "2026-09-10" })],
  ]) {
    const before = structuredClone(s);
    assert.throws(() => applyAction(s, batch(invalid), "operator"));
    assert.deepEqual(s, before);
  }
  assert.throws(() => batch([]));
  assert.throws(() => batch([row("demo-82", { from: "2026-02-30" })]));
});

test("save all validates the final date periods regardless of row order", () => {
  for (const reverse of [false, true]) {
    const s = seed();
    applyAction(
      s,
      actionSchema.parse({
        type: "save-card-mapping",
        revision: 1,
        mapping: row(),
      }),
      "operator",
    );
    const prior = s.cardMappings![0];
    const edits = [
      { ...prior, through: "2026-09-09" },
      row("demo-81", {
        from: "2026-09-10",
        cardUser: "Chris Parker",
        personId: "technician:demo-2",
      }),
    ];
    applyAction(s, batch(reverse ? edits.reverse() : edits), "operator");
    assert.equal(s.cardMappings!.length, 2);
    assert.equal(
      s.records.find((r) => r.id === "Q-1043")?.cardUser,
      "Alex Morgan",
    );
    assert.equal(
      s.records.find((r) => r.id === "Q-1041")?.cardUser,
      "Chris Parker",
    );
    assert.ok(verifyAudit(s.audit));
  }
});

test("save row accepts omitted reasons and preserves unrelated assignments and historical evidence", () => {
  const s = seed();
  applyAction(
    s,
    batch([row(), row("demo-82", { reason: "Historical verification note" })]),
    "operator",
  );
  const untouched = structuredClone(s.cardMappings![0]);
  const edit = s.cardMappings![1];
  applyAction(
    s,
    actionSchema.parse({
      type: "save-card-mapping",
      revision: 1,
      mapping: row("demo-82", { id: edit.id, through: "2026-09-20" }),
    }),
    "operator",
  );
  assert.deepEqual(
    s.cardMappings!.find((m) => m.id === untouched.id),
    untouched,
  );
  assert.equal(
    s.cardMappings!.find((m) => m.id === edit.id)?.reason,
    "Historical verification note",
  );
  assert.equal((s.audit.at(-1)!.detail as any).before.through, undefined);
  assert.equal((s.audit.at(-1)!.detail as any).after.through, "2026-09-20");
  assert.ok(verifyAudit(s.audit));
});

test("bulk API checks auth/origin, persists one revision, rejects stale saves and rolls back bad batches", async () => {
  const env = { ...process.env };
  const globals = globalThis as unknown as { richmondPool?: unknown };
  const oldPool = globals.richmondPool;
  const pg = new PGlite();
  try {
    Object.assign(process.env, {
      NODE_ENV: "production",
      DEMO_MODE: "false",
      DATABASE_URL: "postgres://test-only",
      APP_ORIGIN: "https://app.example",
      APP_USER: "operator",
      APP_PASSWORD: "long-test-password-for-bulk-save",
    });
    await pg.exec(
      await readFile(new URL("../db/001_initial.sql", import.meta.url), "utf8"),
    );
    const s = seed();
    s.mode = "live";
    await pg.query("INSERT INTO app_state(id,payload) VALUES(1,$1)", [
      JSON.stringify(s),
    ]);
    const db: DB = {
      query: async (sql, params) => await pg.query(sql, params),
    };
    globals.richmondPool = {
      ...db,
      connect: async () => ({ ...db, release() {} }),
    };
    const headers = {
      Authorization:
        "Basic " +
        Buffer.from("operator:long-test-password-for-bulk-save").toString(
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
    const body = {
      type: "save-card-mappings",
      revision: s.revision,
      mappings: [row(), row("demo-82")],
    };
    assert.equal(
      (await send(body, { ...headers, Authorization: "" })).status,
      403,
    );
    assert.equal(
      (await send(body, { ...headers, Origin: "https://elsewhere.example" }))
        .status,
      403,
    );
    assert.equal((await send(body)).status, 200);
    const saved = await readDB(db);
    assert.equal(saved.revision, s.revision + 1);
    assert.equal(saved.cardMappings?.length, 2);
    assert.equal(saved.audit.length, 1);
    assert.ok(verifyAudit(saved.audit));
    assert.equal((await send(body)).status, 409);
    assert.equal(
      (
        await send({
          ...body,
          revision: saved.revision,
          mappings: [row("demo-83"), row("unknown")],
        })
      ).status,
      400,
    );
    assert.deepEqual(await readDB(db), saved);
    assert.equal(
      (
        await send({
          ...body,
          revision: saved.revision,
          mappings: [
            row("demo-83", { from: "2026-09-10", through: "2026-09-01" }),
          ],
        })
      ).status,
      400,
    );
    assert.deepEqual(await readDB(db), saved);
  } finally {
    globals.richmondPool = oldPool;
    for (const key of Object.keys(process.env))
      if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await pg.close();
  }
});
