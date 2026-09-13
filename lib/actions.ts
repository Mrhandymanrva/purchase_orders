import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  configSchema,
  cardMappingSchema,
  type State,
  type RecordItem,
  type Directory,
} from "./domain";
import { fingerprint, reconcile, normalize } from "./engine";
import { appendAudit } from "./store";
import { suggestRules } from "./suggestions";
import { applyOwnership } from "./ownership";
import { resolvePerson, accountOptions } from "./directory";
const ruleSchema = z
  .object({
    type: z.enum(["alias", "no-po"]),
    pattern: z.string().trim().min(1).max(150),
    target: z.string().trim().max(150),
    maxCents: z.number().int().min(0).max(10000000),
    description: z.string().trim().min(5).max(500),
  })
  .refine(
    (r) => r.type !== "alias" || r.target.length > 0,
    "Canonical vendor is required",
  );
export const actionSchema = z.discriminatedUnion("type", [
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
    config: configSchema,
  }),
  z.object({
    type: z.literal("decision"),
    revision: z.number().int(),
    resultId: z.string(),
    action: z.enum(["confirm", "dismiss"]),
    reason: z.string().trim().min(5).max(2000),
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
]);
export type Action = z.infer<typeof actionSchema>;
export function applyAction(
  state: State,
  action: Action,
  actor: string,
  snapshot?: RecordItem[],
  directory?: Directory,
  coverage?: State["coverage"],
) {
  const asOf =
    state.mode === "demo"
      ? "2026-09-13"
      : new Date().toISOString().slice(0, 10);
  if (action.type === "save-card-mapping") {
    const data = cardMappingSchema.parse(action.mapping);
    const before = data.id
      ? state.cardMappings?.find((m) => m.id === data.id)
      : undefined;
    if (data.id && !before) throw Error("Subaccount mapping no longer exists");
    if (!accountOptions(state).some((a) => a.id === data.accountId))
      throw Error("Select a subaccount from imported card purchases");
    if (
      process.env.QBO_PARENT_CC_ACCOUNT_ID &&
      data.accountId === process.env.QBO_PARENT_CC_ACCOUNT_ID
    )
      throw Error(
        "The parent credit-card account cannot be assigned to one person",
      );
    if (
      state.cardMappings?.some(
        (m) =>
          m.id !== data.id &&
          m.accountId === data.accountId &&
          data.from <= (m.through || "9999-12-31") &&
          m.from <= (data.through || "9999-12-31"),
      )
    )
      throw Error(
        "This subaccount already has a mapping during those dates. Edit its end date before assigning a new user.",
      );
    const mapping = {
      ...data,
      ...resolvePerson(state, data.cardUser, data.personId, before),
      accountName:
        accountOptions(state).find((a) => a.id === data.accountId)?.name ||
        data.accountName ||
        before?.accountName,
      id: data.id || randomUUID(),
    };
    state.cardMappings = [
      ...(state.cardMappings || []).filter((m) => m.id !== mapping.id),
      mapping,
    ];
    const previous = state.records;
    state.records = applyOwnership(state.records, state);
    const affectedChargeIds = state.records
      .filter(
        (r, i) =>
          r.cardUser !== previous[i].cardUser ||
          r.ownershipSource !== previous[i].ownershipSource,
      )
      .map((r) => r.id);
    const invalidatedDecisionIds = state.decisions
      .filter(
        (d) =>
          fingerprint(state.records, [...d.charges, ...d.pos]) !==
          d.fingerprint,
      )
      .map((d) => d.resultId);
    appendAudit(state, actor, "Card subaccount mapping saved", {
      before: before || null,
      after: mapping,
      affectedChargeIds,
      invalidatedDecisionIds,
    });
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
    appendAudit(state, actor, "Policy updated", {
      before,
      after: state.config,
    });
  }
  if (action.type === "suggest-rule") {
    const rule = { ...action.rule, id: randomUUID(), approved: false };
    state.rules.push(rule);
    appendAudit(state, actor, "Rule proposed", rule);
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
    );
    const r = results.find((r) => r.id === action.resultId);
    if (!r) throw Error("Result no longer exists");
    const pos = action.poIds ?? r.pos;
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
      reason: action.reason,
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
      engine: "1.0.0",
      asOf,
      results: reconcile(
        state.records,
        state.config,
        state.rules,
        asOf,
        state.decisions,
      ),
    });
  }
}
