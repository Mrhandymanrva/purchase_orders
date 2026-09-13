import { randomUUID } from "node:crypto";
import { cardMappingSchema, type CardMapping, type State } from "./domain";
import { accountOptions, resolvePerson } from "./directory";
import { applyOwnership } from "./ownership";
import { fingerprint } from "./engine";
import { appendAudit } from "./store";

// Validate the final roster before mutating state, so closing a period and adding
// its replacement works in either order and a bad row cannot partially save.
export function saveCardMappings(
  state: State,
  inputs: unknown[],
  actor: string,
  bulk: boolean,
) {
  const existing = state.cardMappings || [];
  const accounts = accountOptions(state);
  const parent =
    state.quickbooks?.parentAccountId || process.env.QBO_PARENT_CC_ACCOUNT_ID;
  const seen = new Set<string>();
  const changes = inputs.map((input) => {
    const data = cardMappingSchema.parse(input);
    const before = data.id ? existing.find((m) => m.id === data.id) : undefined;
    if (data.id && !before) throw Error("Subaccount mapping no longer exists");
    if (data.id && seen.has(data.id))
      throw Error("The same assignment was submitted more than once.");
    if (data.id) seen.add(data.id);
    if (parent && data.accountId === parent)
      throw Error(
        "The parent credit-card account cannot be assigned to one person",
      );
    const account = accounts.find((a) => a.id === data.accountId);
    if (!account)
      throw Error("Select a subaccount from imported card purchases");
    const after: CardMapping = {
      ...data,
      ...resolvePerson(state, data.cardUser, data.personId, before),
      reason:
        data.reason || before?.reason || "Saved from card assignment grid",
      accountName: account.name || data.accountName || before?.accountName,
      id: data.id || randomUUID(),
    };
    return { before: before || null, after };
  });
  const next = [
    ...existing.filter((m) => !seen.has(m.id)),
    ...changes.map((c) => c.after),
  ];
  const sorted = [...next].sort(
    (a, b) =>
      a.accountId.localeCompare(b.accountId) || a.from.localeCompare(b.from),
  );
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1],
      current = sorted[i];
    if (
      previous.accountId === current.accountId &&
      current.from <= (previous.through || "9999-12-31")
    )
      throw Error(
        `Subaccount ${current.accountName || current.accountId} already has a mapping during those dates. End the earlier assignment before the next starts. No rows were saved.`,
      );
  }
  const records = applyOwnership(state.records, {
    ...state,
    cardMappings: next,
  });
  const affectedChargeIds = records
    .filter(
      (r, i) =>
        r.cardUser !== state.records[i].cardUser ||
        r.cardPersonId !== state.records[i].cardPersonId ||
        r.ownershipSource !== state.records[i].ownershipSource,
    )
    .map((r) => r.id);
  const invalidatedDecisionIds = state.decisions
    .filter(
      (d) => fingerprint(records, [...d.charges, ...d.pos]) !== d.fingerprint,
    )
    .map((d) => d.resultId);
  state.cardMappings = next;
  state.records = records;
  appendAudit(
    state,
    actor,
    bulk ? "Card subaccount mappings saved" : "Card subaccount mapping saved",
    {
      ...(bulk ? { changes, count: changes.length } : changes[0]),
      affectedChargeIds,
      invalidatedDecisionIds,
    },
  );
}
