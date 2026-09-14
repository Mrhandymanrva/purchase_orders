import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { actionSchema, applyAction } from "../lib/actions";
import { reconcile } from "../lib/engine";
import { seed } from "../lib/seed";
import {
  readState,
  readDB,
  persistDB,
  verifyAudit,
  type DB,
} from "../lib/store";
import type { Decision, Result, State } from "../lib/domain";
import { POST } from "../app/api/actions/route";

const input = {
  type: "decision",
  revision: 1,
  resultId: "example",
  action: "confirm",
};

test("confirmation accepts no reason; dismissals still require an explanation", () => {
  for (const reason of [undefined, "", "   ", "OK", "Verified receipt"])
    assert.equal(actionSchema.safeParse({ ...input, reason }).success, true);
  for (const reason of [undefined, "", "    ", "oops"])
    assert.equal(
      actionSchema.safeParse({ ...input, action: "dismiss", reason }).success,
      false,
    );
  assert.equal(
    actionSchema.safeParse({
      ...input,
      action: "dismiss",
      reason: "Paid outside card account",
    }).success,
    true,
  );
  for (const action of ["confirm", "dismiss"])
    assert.equal(
      actionSchema.safeParse({ ...input, action, reason: "x".repeat(2001) })
        .success,
      false,
    );
  assert.equal(
    actionSchema.safeParse({
      type: "assign-card-user",
      revision: 1,
      chargeId: "Q-1049",
      cardUser: "Alex Morgan",
    }).success,
    false,
  );
});

test("reason-free confirmation API saves the selected PO and audit; stale or invalid reviews leave state unchanged", async () => {
  const prior = process.env.DEMO_MODE;
  process.env.DEMO_MODE = "true";
  try {
    const before = await readState();
    const selected = reconcile(
      before.records,
      before.config,
      before.rules,
      "2026-09-13",
      before.decisions,
      before.coverage,
    ).find((r) => r.charges.includes("Q-1049"))!;
    assert.equal(selected.difference, 0);
    assert.deepEqual(selected.pos, ["PO-2049"]);
    assert.equal(selected.status, "Late PO");
    const send = (body: object) =>
      POST(
        new Request("http://127.0.0.1:3000/api/actions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://127.0.0.1:3000",
          },
          body: JSON.stringify(body),
        }),
      );
    const body = {
      type: "decision",
      revision: before.revision,
      resultId: selected.id,
      action: "confirm",
    };
    const response = await send(body);
    assert.equal(response.status, 200);
    const saved = (await response.json()) as State;
    assert.deepEqual(saved.records, JSON.parse(JSON.stringify(before.records)));
    assert.deepEqual(saved.rules, before.rules);
    assert.equal(saved.revision, before.revision + 1);
    const decision = saved.decisions.at(-1)!;
    assert.deepEqual(decision.charges, ["Q-1049"]);
    assert.deepEqual(decision.pos, ["PO-2049"]);
    assert.equal(decision.reason, "Confirmed in reconciliation review.");
    const audit = saved.audit.at(-1)!;
    assert.equal(audit.action, "Manual confirm");
    const detail = audit.detail as { before: Result; decision: Decision };
    assert.equal(detail.before.id, selected.id);
    assert.deepEqual(detail.decision, decision);
    assert.equal(decision.actor, audit.actor);
    assert.ok(Number.isFinite(Date.parse(decision.at)));
    assert.ok(verifyAudit(saved.audit));
    const reloaded = await readState();
    assert.deepEqual(reloaded.records, before.records);
    assert.deepEqual(JSON.parse(JSON.stringify(reloaded)), saved);
    assert.equal(
      reconcile(
        reloaded.records,
        reloaded.config,
        reloaded.rules,
        "2026-09-13",
        reloaded.decisions,
        reloaded.coverage,
      ).find((r) => r.charges.includes("Q-1049"))!.status,
      "Confirmed",
    );
    assert.equal((await send(body)).status, 409);
    assert.equal(
      (await send({ ...body, revision: saved.revision, action: "dismiss" }))
        .status,
      400,
    );
    for (const poIds of [["unknown"], ["PO-2049", "PO-2049"]])
      assert.equal(
        (await send({ ...body, revision: saved.revision, poIds })).status,
        400,
      );
    assert.deepEqual(await readState(), reloaded);
    const changed = structuredClone(reloaded);
    changed.records.find((r) => r.id === "Q-1049")!.amount += 100;
    assert.notEqual(
      reconcile(
        changed.records,
        changed.config,
        changed.rules,
        "2026-09-13",
        changed.decisions,
        changed.coverage,
      ).find((r) => r.charges.includes("Q-1049"))!.status,
      "Confirmed",
    );
  } finally {
    if (prior === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = prior;
  }
});

test("PostgreSQL retains reason-free confirmations, source links and the immutable audit", async () => {
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
    const selected = reconcile(
      state.records,
      state.config,
      state.rules,
      "2026-09-13",
    ).find((r) => r.charges.includes("Q-1049"))!;
    applyAction(
      state,
      actionSchema.parse({
        ...input,
        revision: state.revision,
        resultId: selected.id,
      }),
      "qa-reviewer",
    );
    state.revision++;
    await persistDB(db as DB, state, 0);
    await db.exec("COMMIT");
    const loaded = await readDB(db as DB);
    assert.deepEqual(loaded.decisions, state.decisions);
    assert.equal(
      loaded.decisions[0].reason,
      "Confirmed in reconciliation review.",
    );
    assert.equal(loaded.decisions[0].actor, "qa-reviewer");
    assert.ok(verifyAudit(loaded.audit));
    assert.equal(
      reconcile(
        loaded.records,
        loaded.config,
        loaded.rules,
        "2026-09-13",
        loaded.decisions,
      ).find((r) => r.charges.includes("Q-1049"))!.status,
      "Confirmed",
    );
    await assert.rejects(db.query("DELETE FROM audit_events"), /append only/);
  } finally {
    await db.close();
  }
});
