import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { seed } from "../lib/seed";
import { readDB, persistDB, verifyAudit, type DB } from "../lib/store";
import { applyAction } from "../lib/actions";
import { reconcile } from "../lib/engine";
import { suggestRules } from "../lib/suggestions";
test("recurrence suggestions are deterministic and never self-approve", () => {
  const state = seed();
  const source = state.records.find((r) => r.id === "Q-1055")!;
  state.rules = state.rules.filter((r) => r.pattern !== "Verizon");
  state.records.push(
    { ...source, id: "extra-1", date: "2026-08-05" },
    { ...source, id: "extra-2", date: "2026-07-05" },
  );
  const results = reconcile(
    state.records,
    state.config,
    state.rules,
    "2026-09-13",
  );
  const proposals = suggestRules(state, results);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].approved, false);
  assert.equal(proposals[0].pattern, "Verizon");
});
test("PostgreSQL migration, transactional override, reload, immutable hash audit and rollback", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      await readFile(new URL("../db/001_initial.sql", import.meta.url), "utf8"),
    );
    await db.query("INSERT INTO app_state(id,payload) VALUES(1,$1)", [
      JSON.stringify(seed()),
    ]);
    await db.exec("BEGIN");
    const state = await readDB(db as DB, true);
    applyAction(
      state,
      {
        type: "save-card-mapping",
        revision: state.revision,
        mapping: {
          accountId: "demo-81",
          cardUser: "Jordan Smith",
          reason: "Verified test subaccount roster",
        },
      },
      "qa-operator",
    );
    const r = reconcile(
      state.records,
      state.config,
      state.rules,
      "2026-09-13",
    )[0];
    applyAction(
      state,
      {
        type: "decision",
        revision: state.revision,
        resultId: r.id,
        action: "dismiss",
        reason: "Reviewed test receipt",
      },
      "qa-operator",
    );
    state.revision++;
    await persistDB(db as DB, state, 0);
    await db.exec("COMMIT");
    const loaded = await readDB(db as DB);
    assert.equal(loaded.decisions.length, 1);
    assert.equal(loaded.cardMappings?.[0].cardUser, "Jordan Smith");
    assert.equal(
      loaded.records.find((r) => r.id === "Q-1041")?.cardUser,
      "Jordan Smith",
    );
    assert.equal(loaded.audit[0].actor, "qa-operator");
    assert.ok(verifyAudit(loaded.audit));
    await assert.rejects(db.query("DELETE FROM audit_events"), /append only/);
    await assert.rejects(
      db.query("UPDATE audit_events SET actor='tampered'"),
      /append only/,
    );
    await assert.rejects(db.query("TRUNCATE audit_events"), /append only/);
    await db.exec("BEGIN");
    await db.query("UPDATE app_state SET payload=$1", [
      JSON.stringify({ ...loaded, revision: 999 }),
    ]);
    await db.exec("ROLLBACK");
    assert.equal((await readDB(db as DB)).revision, 2);
    loaded.audit[0].actor = "tampered";
    assert.equal(verifyAudit(loaded.audit), false);
  } finally {
    await db.close();
  }
});
test("rule suggestions stay inactive until approval, snapshots in audit do not mutate", () => {
  const state = seed();
  applyAction(
    state,
    {
      type: "suggest-rule",
      revision: 1,
      rule: {
        type: "no-po",
        pattern: "Lowe’s",
        target: "",
        maxCents: 40000,
        description: "Approved operational category",
      },
    },
    "qa",
  );
  const rule = state.rules.at(-1)!;
  assert.equal(rule.approved, false);
  applyAction(state, { type: "approve-rule", revision: 1, id: rule.id }, "qa");
  assert.equal(state.rules.find((r) => r.id === rule.id)!.approved, true);
  assert.equal(rule.approved, false); // Previous rule snapshot remains unchanged.
  assert.equal((state.audit[0].detail as any).approved, false);
  assert.ok(verifyAudit(state.audit));
});
test("manual overrides reserve records; invalid PO references rejected", () => {
  const state = seed(),
    results = reconcile(state.records, state.config, state.rules, "2026-09-13");
  const first = results.find((r) => r.charges.includes("Q-1043"))!;
  assert.throws(() =>
    applyAction(
      state,
      {
        type: "decision",
        revision: 1,
        resultId: first.id,
        action: "confirm",
        reason: "Verified receipt",
        poIds: ["unknown"],
      },
      "qa",
    ),
  );
  applyAction(
    state,
    {
      type: "decision",
      revision: 1,
      resultId: first.id,
      action: "confirm",
      reason: "Verified receipt",
      poIds: ["PO-2051"],
    },
    "qa",
  );
  const second = results.find((r) => r.charges.includes("Q-1055"))!;
  assert.throws(
    () =>
      applyAction(
        state,
        {
          type: "decision",
          revision: 1,
          resultId: second.id,
          action: "confirm",
          reason: "Try double allocation",
          poIds: ["PO-2051"],
        },
        "qa",
      ),
    /reserved/,
  );
});
