import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "csv-parse/sync";
import {
  defaults,
  configSchema,
  type RecordItem,
  type Config,
  type State,
  type Decision,
} from "../lib/domain";
import { reconcile, fingerprint, ENGINE_VERSION } from "../lib/engine";
import {
  isReconciled,
  needsReview,
  filterResults,
  reportCSV,
} from "../lib/report";
import { scorecard } from "../lib/scorecard";
import { reconciliationPDFModel } from "../lib/pdf-report-model";
import { seed } from "../lib/seed";
import { actionSchema, applyAction } from "../lib/actions";
import { verifyAudit } from "../lib/store";
const policy: Config = { ...defaults, automationMode: "match-and-flag" };
const rec = (
  id: string,
  source: "qbo" | "st",
  amount = 10000,
  extra: Partial<RecordItem> = {},
): RecordItem => ({
  id,
  source,
  amount,
  vendor: "Lowe's",
  date: "2026-09-01",
  currency: "USD",
  reference: "",
  description: "",
  account: id,
  ...(source === "qbo"
    ? { cardUser: "Alice", cardPersonId: "technician:1" }
    : { technicianId: "1" }),
  ...extra,
});
const run = (
  records: RecordItem[],
  config = policy,
  decisions: Decision[] = [],
) => reconcile(records, config, [], "2026-09-14", decisions);
const charge = (rows: ReturnType<typeof run>, id = "q") =>
  rows.find((r) => r.charges.includes(id))!;
function conserve(records: RecordItem[], results: ReturnType<typeof run>) {
  const ids = results.flatMap((r) => [...r.charges, ...r.pos]);
  assert.deepEqual([...ids].sort(), records.map((r) => r.id).sort());
  assert.equal(new Set(ids).size, ids.length);
  for (const r of results.filter((r) => isReconciled(r.status)))
    assert.ok(Math.abs(r.difference) <= policy.toleranceCents);
}

test("high confidence 1:1 matches are not blocked by a crowded vendor history", () => {
  const rows = [
    rec("q", "qbo"),
    rec("p", "st"),
    ...Array.from({ length: 25 }, (_, i) => rec(`extra-${i}`, "st", 20000 + i)),
  ];
  assert.equal(charge(run(rows, defaults)).status, "Needs review");
  const result = charge(run(rows));
  assert.equal(result.score, 90);
  assert.equal(result.status, "Matched");
  assert.deepEqual(result.pos, ["p"]);
  conserve(rows, run(rows));
});
test("late and uncertain identities match with visible flags and no confidence inflation", () => {
  const rows = [
    rec("q", "qbo"),
    rec("p", "st", 10000, { date: "2026-09-04", technicianId: "2" }),
  ];
  const result = charge(run(rows));
  assert.equal(result.status, "Matched with flags");
  assert.equal(result.score, 88);
  assert.ok(result.flags.includes("Late PO"));
  assert.ok(result.flags.includes("PO technician differs from card user"));
  assert.equal(needsReview(result.status), false);
  assert.equal(charge(run(rows, defaults)).status, "Late PO");
  assert.ok(
    charge(
      run([
        rec("q", "qbo", 10000, { cardPersonId: undefined }),
        rec("p", "st"),
      ]),
    ).flags.includes("Card user / PO technician not fully verified"),
  );
});
test("competing matches choose deterministically, prefer the card user's technician, and never reuse records", () => {
  const rows = [
    rec("q", "qbo"),
    rec("p-a", "st", 10000, { technicianId: "2" }),
    rec("p-b", "st", 10000, { date: "2026-09-02" }),
  ];
  const result = charge(run(rows));
  assert.deepEqual(result.pos, ["p-b"]);
  assert.equal(result.score, 89);
  assert.equal(result.status, "Matched with flags");
  assert.ok(result.flags.includes("Competing PO candidates"));
  assert.ok(result.reasons.some((r) => r.includes("p-a")));
  assert.deepEqual(run(rows), run([...rows].reverse()));
  conserve(rows, run(rows));
  const tied = [
    rec("q1", "qbo"),
    rec("q2", "qbo"),
    rec("p1", "st"),
    rec("p2", "st"),
  ];
  conserve(tied, run(tied));
  assert.equal(run(tied).filter((r) => isReconciled(r.status)).length, 2);
});
test("explicit references win over technician preferences; conflicts never auto reconcile", () => {
  const rows = [
    rec("q", "qbo", 10000, { reference: "PO-2" }),
    rec("p1", "st", 10000, { reference: "PO-1" }),
    rec("p2", "st", 10000, { reference: "PO-2", technicianId: "2" }),
  ];
  assert.deepEqual(charge(run(rows)).pos, ["p2"]);
  assert.equal(charge(run(rows.slice(0, 2))).status, "Needs review");
  const mismatch = [rows[0], rows[1], { ...rows[2], amount: 12000 }];
  assert.deepEqual(charge(run(mismatch)).pos, ["p2"]);
  assert.equal(charge(run(mismatch)).status, "Partial match");
});
test("amount-pruned groups find 1:many and many:1 purchases and refunds beyond 14 candidates", () => {
  for (const sign of [1, -1])
    for (const reverse of [false, true]) {
      const one = reverse ? "st" : "qbo",
        many = reverse ? "qbo" : "st";
      const rows = [
        rec("anchor", one, 10000 * sign),
        rec("part1", many, 3000 * sign),
        rec("part2", many, 7000 * sign),
        ...Array.from({ length: 20 }, (_, i) =>
          rec(`other${i}`, many, (20000 + i) * sign),
        ),
      ];
      const result = run(rows).find(
        (r) => r.charges.includes("anchor") || r.pos.includes("anchor"),
      )!;
      assert.equal(result.kind, reverse ? "many:1" : "1:many");
      assert.equal(result.status, "Matched");
      assert.equal(result.difference, 0);
      assert.equal(result.flags.includes("Refund / credit"), sign < 0);
      conserve(rows, run(rows));
    }
});
test("duplicates, missing vendors, mismatched amounts, dates, signs and thresholds remain exceptions", () => {
  const duplicates = [
    rec("q", "qbo", 10000, { account: "same" }),
    rec("q2", "qbo", 10000, { account: "same" }),
    rec("p", "st"),
  ];
  assert.equal(charge(run(duplicates)).status, "Possible duplicate");
  assert.equal(
    charge(
      run([rec("q", "qbo", 10000, { vendorMissing: true }), rec("p", "st")]),
    ).status,
    "Missing vendor",
  );
  for (const amount of [9990, 11000])
    assert.ok(
      needsReview(
        charge(
          run([
            rec("q", "qbo", amount, { reference: "PO" }),
            rec("p", "st", 10000, { reference: "PO" }),
          ]),
        ).status,
      ),
    );
  assert.ok(
    needsReview(
      charge(
        run([rec("q", "qbo"), rec("p", "st")], {
          ...policy,
          autoThreshold: 91,
        }),
      ).status,
    ),
  );
  for (const extra of [
    { date: "2026-07-01" },
    { vendor: "Unapproved vendor" },
    { amount: -10000 },
  ])
    assert.equal(
      charge(run([rec("q", "qbo"), rec("p", "st", 10000, extra)])).pos.length,
      0,
    );
});
test("search budgets become explicit flags rather than blocking a balanced match", () => {
  const rows = [
    rec("q", "qbo", 300),
    rec("exact", "st", 300),
    ...Array.from({ length: 35 }, (_, i) => rec(`small-${i}`, "st", 100)),
  ];
  const result = charge(run(rows));
  assert.deepEqual(result.pos, ["exact"]);
  assert.equal(result.status, "Matched with flags");
  assert.ok(result.flags.includes("Group search limited"));
  conserve(rows, run(rows));
  const unqualified = charge(run(rows, { ...policy, autoThreshold: 100 }));
  assert.ok(needsReview(unqualified.status));
  assert.ok(unqualified.flags.includes("Group search limited"));
});
test("manual decisions reserve their evidence across policy changes and invalidate when the source changes", () => {
  const rows = [rec("q", "qbo"), rec("p", "st")];
  const d: Decision = {
    resultId: "manual",
    charges: ["q"],
    pos: ["p"],
    fingerprint: fingerprint(rows, ["q", "p"]),
    action: "confirm",
    reason: "",
    actor: "operator",
    at: "2026-09-14T12:00:00Z",
  };
  assert.equal(charge(run(rows, policy, [d])).status, "Confirmed");
  assert.notEqual(
    charge(run([{ ...rows[0], amount: 9000 }, rows[1]], policy, [d])).status,
    "Confirmed",
  );
});
test("flagged matches are reconciled in filters, CSV, PDF and technician attribution", () => {
  const state = seed();
  state.records = [
    rec("q", "qbo"),
    rec("p", "st", 10000, { technicianId: "2", description: "VS" }),
  ];
  state.rules = [];
  state.decisions = [];
  const results = run(state.records);
  assert.equal(filterResults(results, state, { status: "Matched" }).length, 1);
  assert.equal(
    filterResults(results, state, {
      status: "Matched with flags",
      individual: "Alice",
    }).length,
    1,
  );
  assert.equal(
    filterResults(results, state, { status: "Needs review" }).length,
    0,
  );
  const csv = parse<Record<string, string>>(reportCSV(state, results, {}), {
    bom: true,
    columns: true,
  });
  assert.equal(csv[0]["Link state"], "Reconciled");
  assert.match(csv[0].Flags, /differs/);
  assert.equal(csv[0]["Engine version"], ENGINE_VERSION);
  const pdf = reconciliationPDFModel(state, results, {});
  assert.equal(pdf.metrics[2].value, "0");
  assert.match(pdf.tables[0].rows[0][5], /Reconciled link/);
  assert.match(pdf.tables[0].rows[0][5], /differs/);
  const data = scorecard(state, results, {
    from: "2026-09-01",
    to: "2026-09-30",
  });
  assert.equal(data.total.poTotal, 10000);
  assert.equal(data.total.spend, 10000);
  assert.equal(data.rows.find((r) => r.id === "technician:1")?.poTotal, 10000);
  assert.match(
    data.evidence.find((e) => e.record.id === "p")!.basis,
    /matched with flags/,
  );
});
test("policy changes validate, preserve decisions and rules, and audit the resulting links and source evidence", () => {
  const { automationMode, ...legacy } = defaults;
  assert.equal(configSchema.parse(legacy).automationMode, "strict");
  assert.equal(
    actionSchema.safeParse({
      type: "config",
      revision: 1,
      config: { ...policy, automationMode: "ignore-everything" },
    }).success,
    false,
  );
  const state = seed(),
    before = structuredClone(state);
  applyAction(
    state,
    actionSchema.parse({
      type: "config",
      revision: state.revision,
      config: policy,
    }),
    "operator",
  );
  assert.deepEqual(state.records, before.records);
  assert.deepEqual(state.decisions, before.decisions);
  assert.deepEqual(state.rules, before.rules);
  const audit = state.audit.at(-1)!;
  assert.equal(audit.action, "Policy updated");
  assert.equal(audit.actor, "operator");
  const detail = audit.detail as {
    results: ReturnType<typeof run>;
    sourceFingerprint: string;
    engine: string;
    after: Config;
  };
  assert.equal(detail.engine, ENGINE_VERSION);
  assert.equal(detail.after.automationMode, "match-and-flag");
  assert.equal(
    detail.sourceFingerprint,
    fingerprint(
      state.records,
      state.records.map((r) => r.id),
    ),
  );
  assert.ok(detail.results.some((r) => r.status === "Matched with flags"));
  assert.ok(verifyAudit(state.audit));
});
test("hundreds of transactions reconcile deterministically with conserved source totals", () => {
  const rows = Array.from({ length: 250 }, (_, i) => [
    rec(`q${i}`, "qbo", 10000 + i),
    rec(`p${i}`, "st", 10000 + i),
  ]).flat();
  const start = performance.now(),
    results = run(rows);
  assert.equal(results.length, 250);
  assert.ok(results.every((r) => isReconciled(r.status)));
  conserve(rows, results);
  assert.deepEqual(results, run(rows.slice().reverse()));
  assert.ok(
    performance.now() - start < 15000,
    "500 records should process within 15 seconds",
  );
});
