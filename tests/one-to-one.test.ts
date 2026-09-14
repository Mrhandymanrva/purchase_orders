import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaults,
  configSchema,
  type Config,
  type RecordItem,
  type Decision,
} from "../lib/domain";
import { reconcile, fingerprint, ENGINE_VERSION } from "../lib/engine";
import { actionSchema, applyAction } from "../lib/actions";
import { seed } from "../lib/seed";
import { verifyAudit } from "../lib/store";
import { isReconciled } from "../lib/report";

const modes = ["strict", "match-and-flag"] as const;
const rec = (
  id: string,
  source: "qbo" | "st",
  amount: number,
  extra: Partial<RecordItem> = {},
): RecordItem => ({
  id,
  source,
  amount,
  vendor: "Home Depot",
  date: "2026-09-03",
  currency: "USD",
  reference: "",
  description: "",
  account: id,
  ...(source === "qbo"
    ? { cardUser: "Jacob", cardPersonId: "technician:1" }
    : { technicianId: "1" }),
  ...extra,
});
const run = (
  records: RecordItem[],
  automationMode: Config["automationMode"] = "match-and-flag",
  decisions: Decision[] = [],
) =>
  reconcile(
    records,
    { ...defaults, automationMode },
    [],
    "2026-09-14",
    decisions,
  );
function conserved(records: RecordItem[], results: ReturnType<typeof run>) {
  const ids = results.flatMap((r) => [...r.charges, ...r.pos]);
  assert.deepEqual(ids.slice().sort(), records.map((r) => r.id).sort());
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(results.every((r) => r.charges.length <= 1 && r.pos.length <= 1));
  assert.ok(results.every((r) => !r.flags.includes("Group search limited")));
}
function decision(
  records: RecordItem[],
  charges: string[],
  pos: string[],
): Decision {
  return {
    resultId: JSON.stringify([charges.slice().sort(), pos.slice().sort()]),
    fingerprint: fingerprint(records, [...charges, ...pos]),
    charges,
    pos,
    action: "confirm",
    reason: "Previously confirmed",
    actor: "operator",
    at: "2026-09-14T12:00:00Z",
  };
}

test("new workspaces and policy saves enforce 1:1 while historical configs remain readable", () => {
  assert.equal(defaults.maxGroup, 1);
  assert.equal(seed().config.maxGroup, 1);
  assert.equal(configSchema.parse({ ...defaults, maxGroup: 3 }).maxGroup, 3);
  for (const maxGroup of [1, 2, 3, 4]) {
    assert.equal(
      actionSchema.safeParse({
        type: "config",
        revision: 0,
        config: { ...defaults, maxGroup },
      }).success,
      maxGroup === 1,
    );
  }
});

test("the $88.70 screenshot purchase cannot combine three older POs totaling $88.69", () => {
  for (const mode of modes)
    for (const sign of [1, -1]) {
      const records = [
        rec("q", "qbo", sign * 8870),
        rec("p1", "st", sign * 682, { date: "2026-08-14" }),
        rec("p2", "st", sign * 3801, { date: "2026-08-20" }),
        rec("p3", "st", sign * 4386, { date: "2026-08-14" }),
      ];
      const results = run(records, mode);
      assert.deepEqual(results.find((r) => r.charges.includes("q"))!.pos, []);
      assert.ok(results.every((r) => !isReconciled(r.status)));
      conserved(records, results);
    }
});

test("split card transactions cannot combine against a single PO, including refunds", () => {
  for (const mode of modes)
    for (const sign of [1, -1]) {
      const records = [
        rec("q1", "qbo", sign * 3000),
        rec("q2", "qbo", sign * 7000),
        rec("p", "st", sign * 10000),
      ];
      const results = run(records, mode);
      assert.ok(results.every((r) => !isReconciled(r.status)));
      conserved(records, results);
    }
});

test("every eligible single PO is searched even beyond the legacy group pool limit", () => {
  for (const mode of modes) {
    const records = [
      rec("q", "qbo", 10000),
      ...Array.from({ length: 30 }, (_, i) => rec(`p${i}`, "st", 100 + i)),
      rec("p-exact", "st", 10000),
    ];
    const results = run(records, mode),
      match = results.find((r) => r.charges.includes("q"))!;
    assert.equal(match.status, "Matched");
    assert.equal(match.score, 90);
    assert.deepEqual(match.pos, ["p-exact"]);
    assert.ok(match.reasons.some((r) => r.includes("One-to-one policy")));
    assert.deepEqual(results, run(records.slice().reverse(), mode));
    conserved(records, results);
  }
});

test("single-PO refunds keep their sign and cannot match positive purchases", () => {
  const records = [
    rec("refund", "qbo", -5037),
    rec("credit", "st", -5037),
    rec("positive", "st", 5037),
  ];
  const results = run(records),
    refund = results.find((r) => r.charges.includes("refund"))!;
  assert.equal(refund.status, "Matched");
  assert.equal(refund.amount, -5037);
  assert.equal(refund.difference, 0);
  assert.deepEqual(refund.pos, ["credit"]);
  conserved(records, results);
});

test("1:1 automation retains uncertainty flags but never hides hard exceptions", () => {
  const flagged = run([
    rec("q", "qbo", 10000),
    rec("p", "st", 10000, { date: "2026-09-06", technicianId: "2" }),
  ])[0];
  assert.equal(flagged.status, "Matched with flags");
  assert.ok(flagged.flags.includes("Late PO"));
  assert.ok(flagged.flags.includes("PO technician differs from card user"));
  for (const records of [
    [
      rec("q", "qbo", 10000, { reference: "PO-1" }),
      rec("p", "st", 10500, { reference: "PO-1" }),
    ],
    [
      rec("q", "qbo", 10000, { reference: "PO-1" }),
      rec("p", "st", 10000, { reference: "PO-2" }),
    ],
    [
      rec("q", "qbo", 10000, { account: "same" }),
      rec("q2", "qbo", 10000, { account: "same" }),
      rec("p", "st", 10000),
    ],
  ]) {
    const results = run(records);
    assert.ok(results.every((r) => !isReconciled(r.status)));
    conserved(records, results);
  }
});

test("legacy grouped decisions remain in history without reserving records under 1:1", () => {
  const records = [
    rec("q", "qbo", 10000),
    rec("p1", "st", 3000),
    rec("p2", "st", 7000),
    rec("p", "st", 10000),
    rec("q-saved", "qbo", 777),
    rec("p-saved", "st", 777),
    rec("q-refund", "qbo", -555),
  ];
  const decisions = [
    decision(records, ["q"], ["p1", "p2"]),
    decision(records, ["q-saved"], ["p-saved"]),
    decision(records, ["q-refund"], []),
  ];
  const before = structuredClone(decisions),
    results = run(records, "match-and-flag", decisions);
  assert.deepEqual(results.find((r) => r.charges.includes("q"))!.pos, ["p"]);
  assert.equal(results.filter((r) => r.status === "Confirmed").length, 2);
  assert.deepEqual(decisions, before);
  conserved(records, results);
});

test("policy application audits excluded historical groups and keeps records, rules and decisions intact", () => {
  const state = seed();
  state.records = [
    rec("q", "qbo", 10000),
    rec("p1", "st", 3000),
    rec("p2", "st", 7000),
  ];
  state.config = { ...defaults, maxGroup: 3 };
  state.decisions = [decision(state.records, ["q"], ["p1", "p2"])];
  const before = structuredClone(state);
  applyAction(
    state,
    actionSchema.parse({
      type: "config",
      revision: state.revision,
      config: { ...state.config, maxGroup: 1 },
    }),
    "operator",
  );
  assert.deepEqual(state.records, before.records);
  assert.deepEqual(state.rules, before.rules);
  assert.deepEqual(state.decisions, before.decisions);
  const detail = state.audit.at(-1)!.detail as {
    engine: string;
    excludedDecisions: Decision[];
    results: ReturnType<typeof run>;
    before: Config;
    after: Config;
  };
  assert.equal(detail.engine, ENGINE_VERSION);
  assert.equal(detail.before.maxGroup, 3);
  assert.equal(detail.after.maxGroup, 1);
  assert.deepEqual(detail.excludedDecisions, before.decisions);
  conserved(state.records, detail.results);
  assert.ok(verifyAudit(state.audit));
});

test("manual saves reject multiple PO overrides and inactive grouped decisions cannot block a 1:1 correction", () => {
  const state = seed();
  state.records = [
    rec("q", "qbo", 10000),
    rec("p1", "st", 3000),
    rec("p2", "st", 7000),
    rec("p", "st", 10000),
  ];
  state.rules = [];
  state.decisions = [decision(state.records, ["q"], ["p1", "p2"])];
  const result = reconcile(
    state.records,
    state.config,
    [],
    "2026-09-13",
    state.decisions,
  ).find((r) => r.charges.includes("q"))!;
  const save = (poIds: string[]) =>
    applyAction(
      state,
      actionSchema.parse({
        type: "decision",
        revision: state.revision,
        resultId: result.id,
        action: "confirm",
        poIds,
      }),
      "operator",
    );
  const before = structuredClone(state);
  assert.throws(() => save(["p1", "p2"]), /One-to-one/);
  assert.deepEqual(state, before);
  save(["p"]);
  const results = run(state.records, "strict", state.decisions);
  assert.equal(
    results.find((r) => r.charges.includes("q"))!.status,
    "Confirmed",
  );
  assert.deepEqual(results.find((r) => r.charges.includes("q"))!.pos, ["p"]);
  conserved(state.records, results);
  assert.ok(verifyAudit(state.audit));
});
