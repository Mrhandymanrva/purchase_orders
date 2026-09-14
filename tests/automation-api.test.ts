import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { actionSchema, applyAction } from "../lib/actions";
import { defaults, type State } from "../lib/domain";
import {
  readState,
  readDB,
  persistDB,
  verifyAudit,
  type DB,
} from "../lib/store";
import { reconcile } from "../lib/engine";
import { seed } from "../lib/seed";
import { POST } from "../app/api/actions/route";

test("policy API applies flagged matching immediately, rejects stale saves, and keeps imports and manual decisions", async () => {
  const previous = process.env.DEMO_MODE;
  process.env.DEMO_MODE = "true";
  try {
    const before: State = JSON.parse(JSON.stringify(await readState()));
    const send = (revision: number) =>
      POST(
        new Request("http://127.0.0.1:3000/api/actions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://127.0.0.1:3000",
          },
          body: JSON.stringify({
            type: "config",
            revision,
            config: { ...before.config, automationMode: "match-and-flag" },
          }),
        }),
      );
    const response = await send(before.revision);
    assert.equal(response.status, 200);
    const after: State = await response.json();
    assert.equal(after.config.automationMode, "match-and-flag");
    assert.equal(after.config.maxGroup, 1);
    assert.deepEqual(after.records, before.records);
    assert.deepEqual(after.rules, before.rules);
    assert.deepEqual(after.decisions, before.decisions);
    assert.equal(after.revision, before.revision + 1);
    assert.ok(verifyAudit(after.audit));
    assert.ok(
      reconcile(
        after.records,
        after.config,
        after.rules,
        "2026-09-13",
        after.decisions,
        after.coverage,
      ).some((r) => r.status === "Matched with flags"),
    );
    assert.equal((await send(before.revision)).status, 409);
    assert.deepEqual(JSON.parse(JSON.stringify(await readState())), after);
  } finally {
    if (previous === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = previous;
  }
});
test("PostgreSQL reload preserves the new policy, resulting allocations, and immutable audit evidence", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      await readFile(new URL("../db/001_initial.sql", import.meta.url), "utf8"),
    );
    await db.query("INSERT INTO app_state(id,payload) VALUES(1,$1)", [
      JSON.stringify({ ...seed(), config: { ...defaults, maxGroup: 3 } }),
    ]);
    await db.exec("BEGIN");
    const s = await readDB(db as DB, true);
    applyAction(
      s,
      actionSchema.parse({
        type: "config",
        revision: s.revision,
        config: { ...defaults, automationMode: "match-and-flag" },
      }),
      "operator",
    );
    s.revision++;
    await persistDB(db as DB, s, 0);
    await db.exec("COMMIT");
    const loaded = await readDB(db as DB);
    assert.equal(loaded.config.automationMode, "match-and-flag");
    assert.equal(loaded.config.maxGroup, 1);
    assert.ok(
      reconcile(
        loaded.records,
        loaded.config,
        loaded.rules,
        "2026-09-13",
      ).every((r) => r.charges.length <= 1 && r.pos.length <= 1),
    );
    assert.deepEqual(loaded.records, s.records);
    assert.deepEqual(loaded.rules, s.rules);
    assert.deepEqual(loaded.decisions, s.decisions);
    assert.deepEqual(
      reconcile(loaded.records, loaded.config, loaded.rules, "2026-09-13"),
      reconcile(s.records, s.config, s.rules, "2026-09-13"),
    );
    assert.ok(verifyAudit(loaded.audit));
    await assert.rejects(db.query("DELETE FROM audit_events"), /append only/);
  } finally {
    await db.close();
  }
});
