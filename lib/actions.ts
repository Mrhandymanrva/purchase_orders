import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  configSchema,
  cardMappingSchema,
  type State,
  type RecordItem,
  type Directory,
} from "./domain";
import {
  fingerprint,
  reconcile,
  normalize,
  ENGINE_VERSION,
  decisionFitsPolicy,
} from "./engine";
import { appendAudit } from "./store";
import { suggestRules } from "./suggestions";
import { applyOwnership } from "./ownership";
import { saveCardMappings } from "./save-card-mappings";
import { ServiceTitanSetupError } from "./servicetitan-settings";
const ruleSchema = z
  .object({
    type: z.enum(["alias", "no-po"]),
    pattern: z.string().trim().min(1).max(150),
    target: z.string().trim().max(150),
    maxCents: z.number().int().min(0).max(10000000).nullable(),
    description: z.string().trim().min(5).max(500),
  })
  .refine(
    (r) => r.type !== "alias" || r.target.length > 0,
    "Canonical vendor is required",
  );
export const actionSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("discover-st-business-units"),
      revision: z.number().int(),
    }),
    z.object({
      type: z.literal("save-st-business-units"),
      revision: z.number().int(),
      businessUnitIds: z.array(z.string().trim().min(1)).min(1).max(50),
      reason: z.string().trim().min(5).max(500),
    }),
    z.object({
      type: z.literal("refresh-directory"),
      revision: z.number().int(),
    }),
    z.object({
      type: z.literal("scorecard-settings"),
      revision: z.number().int(),
      vanStockTypeIds: z.array(z.string().min(1)).max(50),
      reason: z.string().trim().min(5).max(500),
    }),
    z.object({
      type: z.literal("save-card-mappings"),
      revision: z.number().int(),
      mappings: z.array(cardMappingSchema).min(1).max(500),
    }),
    z.object({
      type: z.literal("save-card-mapping"),
      revision: z.number().int(),
      mapping: cardMappingSchema,
    }),
    z.object({
      type: z.literal("assign-card-user"),
      revision: z.number().int(),
      chargeId: z.string(),
      cardUser: z.string().trim().min(2).max(100),
      reason: z.string().trim().min(5).max(500),
    }),
    z.object({
      type: z.literal("config"),
      revision: z.number().int(),
      config: configSchema.extend({ maxGroup: z.literal(1) }),
    }),
    z.object({
      type: z.literal("decision"),
      revision: z.number().int(),
      resultId: z.string(),
      action: z.enum(["confirm", "dismiss"]),
      reason: z.string().trim().max(2000).default(""),
      poIds: z.array(z.string().trim().min(1)).max(20).optional(),
    }),
    z.object({
      type: z.literal("suggest-rule"),
      revision: z.number().int(),
      rule: ruleSchema,
    }),
    z.object({
      type: z.literal("approve-rule"),
      revision: z.number().int(),
      id: z.string(),
    }),
    z.object({ type: z.literal("sync"), revision: z.number().int() }),
  ])
  .superRefine((action, ctx) => {
    if (
      action.type === "decision" &&
      action.action === "dismiss" &&
      action.reason.length < 5
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Enter a reason for dismissing the exception (5+ characters).",
      });
    }
  });
export type Action = z.infer<typeof actionSchema>;
export function applyAction(
  state: State,
  action: Action,
  actor: string,
  snapshot?: RecordItem[],
  directory?: Directory,
  coverage?: State["coverage"],
  stBusinessUnits?: State["serviceTitan"],
) {
  const asOf =
    state.mode === "demo"
      ? "2026-09-13"
      : new Date().toISOString().slice(0, 10);
  if (action.type === "discover-st-business-units") {
    if (state.mode === "live" && !stBusinessUnits)
      throw new ServiceTitanSetupError(
        "ServiceTitan business units could not be loaded.",
      );
    if (stBusinessUnits) {
      const saved = state.serviceTitan;
      if (
        saved &&
        (saved.tenantId !== stBusinessUnits.tenantId ||
          saved.environment !== stBusinessUnits.environment)
      )
        throw new ServiceTitanSetupError(
          "ServiceTitan connection changed. Restore the original tenant and environment.",
        );
      state.serviceTitan = {
        ...stBusinessUnits,
        ...(saved?.businessUnitIds
          ? { businessUnitIds: saved.businessUnitIds }
          : {}),
      };
    }
    appendAudit(state, actor, "ServiceTitan business units loaded", {
      count: state.serviceTitan?.businessUnits.length || 0,
      environment: state.serviceTitan?.environment,
      tenantId: state.serviceTitan?.tenantId,
    });
  }
  if (action.type === "save-st-business-units") {
    const st = state.serviceTitan;
    if (!st?.discoveredAt)
      throw new ServiceTitanSetupError(
        "Load ServiceTitan business units before choosing the PO import scope.",
      );
    const ids = [...new Set(action.businessUnitIds)].sort();
    if (
      !ids.length ||
      ids.length !== action.businessUnitIds.length ||
      ids.some(
        (id) => !st.businessUnits.some((unit) => unit.id === id && unit.active),
      )
    )
      throw new ServiceTitanSetupError(
        "Choose at least one active ServiceTitan business unit from the list, without duplicates.",
      );
    const before = st.businessUnitIds || [];
    st.businessUnitIds = ids;
    appendAudit(state, actor, "ServiceTitan PO import scope saved", {
      before,
      after: ids.map((id) => ({
        id,
        name: st.businessUnits.find((unit) => unit.id === id)!.name,
      })),
      tenantId: st.tenantId,
      environment: st.environment,
      reason: action.reason,
      appliesOnNextSync: true,
    });
  }
  if (
    action.type === "save-card-mapping" ||
    action.type === "save-card-mappings"
  ) {
    saveCardMappings(
      state,
      action.type === "save-card-mapping" ? [action.mapping] : action.mappings,
      actor,
      action.type === "save-card-mappings",
    );
  }
  if (action.type === "scorecard-settings") {
    const ids = [...new Set(action.vanStockTypeIds)];
    if (ids.some((id) => !state.directory?.poTypes.some((t) => t.id === id)))
      throw Error("Select Van Stock types from the ServiceTitan directory.");
    const before = state.vanStockTypeIds || [];
    state.vanStockTypeIds = ids;
    appendAudit(state, actor, "Van Stock scorecard types saved", {
      before,
      after: ids,
      reason: action.reason,
    });
  }
  if (action.type === "refresh-directory") {
    if (state.mode === "live" && !directory)
      throw Error("Integration directory snapshot missing");
    if (directory) state.directory = directory;
    appendAudit(state, actor, "Assignment dropdowns refreshed", {
      people: state.directory?.people.length || 0,
      accounts: state.directory?.accounts.length || 0,
      poTypes: state.directory?.poTypes.length || 0,
    });
  }
  if (action.type === "assign-card-user") {
    const charge = state.records.find(
      (r) => r.id === action.chargeId && r.source === "qbo",
    );
    if (!charge) throw Error("Card charge not found");
    const before = {
      cardUser: charge.cardUser || "Unassigned",
      ownershipSource: charge.ownershipSource || "Unassigned",
    };
    state.cardAssignments ??= {};
    charge.importedCardUser ??= charge.cardUser || "Unassigned";
    charge.importedOwnershipSource ??= charge.ownershipSource || "Unassigned";
    state.cardAssignments[charge.id] = action.cardUser;
    charge.cardUser = action.cardUser;
    charge.cardPersonId = undefined;
    charge.ownershipSource = "Manual assignment";
    appendAudit(state, actor, "Card user assigned", {
      chargeId: charge.id,
      before,
      after: {
        cardUser: charge.cardUser,
        ownershipSource: charge.ownershipSource,
      },
      reason: action.reason,
    });
  }
  if (action.type === "config") {
    const before = state.config;
    state.config = action.config;
    const evaluate = (config: State["config"]) =>
      reconcile(
        state.records,
        config,
        state.rules,
        asOf,
        state.decisions,
        state.coverage,
      );
    const priorResults = evaluate(before),
      results = evaluate(state.config);
    const counts = (rows: typeof results) =>
      rows.reduce<Record<string, number>>(
        (all, r) => ({ ...all, [r.status]: (all[r.status] || 0) + 1 }),
        {},
      );
    appendAudit(state, actor, "Policy updated", {
      before,
      after: state.config,
      engine: ENGINE_VERSION,
      asOf,
      coverage: state.coverage,
      ruleIds: state.rules.filter((r) => r.approved).map((r) => r.id),
      sourceFingerprint: fingerprint(
        state.records,
        state.records.map((r) => r.id),
      ),
      excludedDecisions: state.decisions.filter(
        (d) => !decisionFitsPolicy(d, state.config),
      ),
      statusCountsBefore: counts(priorResults),
      statusCountsAfter: counts(results),
      results,
    });
  }
  if (action.type === "suggest-rule") {
    const sameVendor = state.rules.filter(
      (r) =>
        r.type === action.rule.type &&
        normalize(r.pattern) === normalize(action.rule.pattern),
    );
    if (sameVendor.some((r) => r.approved))
      throw Error(
        "An approved rule already uses this vendor; it cannot be changed by submitting a suggestion",
      );
    if (sameVendor.length > 1)
      throw Error(
        "Multiple pending rules use this vendor. Resolve them before changing the suggestion",
      );
    const prior = sameVendor[0];
    const rule = {
      ...action.rule,
      id: prior?.id || randomUUID(),
      approved: false,
    };
    if (prior) {
      state.rules[state.rules.indexOf(prior)] = rule;
      appendAudit(state, actor, "Rule suggestion updated", {
        before: prior,
        after: rule,
      });
    } else {
      state.rules.push(rule);
      appendAudit(state, actor, "Rule proposed", rule);
    }
  }
  if (action.type === "approve-rule") {
    const rule = state.rules.find((r) => r.id === action.id);
    if (!rule || rule.approved) throw Error("Pending rule not found");
    if (
      state.rules.some(
        (r) =>
          r.approved &&
          r.type === rule.type &&
          normalize(r.pattern) === normalize(rule.pattern),
      )
    )
      throw Error(
        "An approved rule already uses this vendor; retire it before replacement",
      );
    rule.approved = true;
    appendAudit(state, actor, "Rule explicitly approved", rule);
  }
  if (action.type === "decision") {
    const results = reconcile(
      state.records,
      state.config,
      state.rules,
      asOf,
      state.decisions,
      state.coverage,
    );
    const r = results.find((r) => r.id === action.resultId);
    if (!r) throw Error("Result no longer exists");
    const pos = action.poIds ?? r.pos;
    if (!decisionFitsPolicy({ charges: r.charges, pos }, state.config))
      throw Error(
        "One-to-one matching allows at most one purchase and one PO per decision. Select a single PO ID.",
      );
    if (
      new Set(pos).size !== pos.length ||
      pos.some(
        (id) => !state.records.some((x) => x.id === id && x.source === "st"),
      )
    )
      throw Error("Override contains an invalid or duplicate PO ID");
    const ids = [...r.charges, ...pos];
    const locked = state.decisions.filter(
      (d) =>
        d.resultId !== r.id &&
        decisionFitsPolicy(d, state.config) &&
        fingerprint(state.records, [...d.charges, ...d.pos]) === d.fingerprint,
    );
    if (
      locked.some((d) =>
        [...d.charges, ...d.pos].some((id) => ids.includes(id)),
      )
    )
      throw Error("A record is already reserved by another manual decision");
    const decision = {
      resultId: JSON.stringify([r.charges.slice().sort(), pos.slice().sort()]),
      fingerprint: fingerprint(state.records, ids),
      action: action.action,
      reason:
        action.action === "confirm" && !action.reason.trim()
          ? "Confirmed in reconciliation review."
          : action.reason,
      actor,
      at: new Date().toISOString(),
      charges: r.charges,
      pos,
    };
    state.decisions = state.decisions.filter((d) => d.resultId !== r.id);
    state.decisions.push(decision);
    appendAudit(state, actor, "Manual " + action.action, {
      before: r,
      decision,
    });
  }
  if (action.type === "sync") {
    if (directory) state.directory = directory;
    if (coverage) state.coverage = coverage;
    if (state.mode === "live" && !snapshot)
      throw Error("Live snapshot missing");
    const before = state.records;
    state.records = applyOwnership(snapshot || state.records, state);
    const invalidated = state.decisions
      .filter(
        (d) =>
          fingerprint(state.records, [...d.charges, ...d.pos]) !==
          d.fingerprint,
      )
      .map((d) => d.resultId);
    state.lastSync = new Date().toISOString();
    const proposals = suggestRules(
      state,
      reconcile(
        state.records,
        state.config,
        state.rules,
        asOf,
        state.decisions,
        state.coverage,
      ),
    );
    for (const proposal of proposals) {
      const rule = { ...proposal, id: randomUUID() };
      state.rules.push(rule);
      appendAudit(state, actor, "Rule suggested by recurrence check", rule);
    }
    appendAudit(state, actor, "Reconciliation run", {
      mode: state.mode,
      sourceCount: state.records.length,
      sourceFingerprint: fingerprint(
        state.records,
        state.records.map((r) => r.id),
      ),
      previousCount: before.length,
      invalidatedDecisions: invalidated,
      policy: state.config,
      ruleIds: state.rules.filter((r) => r.approved).map((r) => r.id),
      engine: ENGINE_VERSION,
      asOf,
      coverage: state.coverage,
      results: reconcile(
        state.records,
        state.config,
        state.rules,
        asOf,
        state.decisions,
        state.coverage,
      ),
    });
  }
}
