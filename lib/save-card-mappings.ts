import { randomUUID } from "node:crypto";
import { cardMappingSchema, type CardMapping, type State } from "./domain";
import { accountOptions, resolvePerson } from "./directory";
import { applyOwnership } from "./ownership";
import { fingerprint } from "./engine";
import { appendAudit } from "./store";

// One permanent employee per card. Corrections affect all of that card's
// purchases. Validate the complete roster before mutating any records.
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
  const seenAccounts = new Set<string>();
  const changes = inputs.map((input) => {
    const data = cardMappingSchema.parse(input);
    const before = data.id
      ? existing.find((m) => m.id === data.id)
      : existing.find((m) => m.accountId === data.accountId);
    if (data.id && !before) throw Error("Subaccount mapping no longer exists");
    if (seenAccounts.has(data.accountId) || (before && seen.has(before.id)))
      throw Error(
        "The same card was submitted more than once. Use one employee per card.",
      );
    seenAccounts.add(data.accountId);
    if (before) seen.add(before.id);
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
      id: before?.id || randomUUID(),
    };
    return { before: before || null, after };
  });
  const next = [
    ...existing.filter((m) => !seen.has(m.id)),
    ...changes.map((c) => c.after),
  ];
  if (new Set(next.map((m) => m.accountId)).size !== next.length)
    throw Error(
      "A card already has a mapping. Edit that card's existing row. No rows were saved.",
    );
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
      scope:
        "All purchases for each card, regardless of purchase date or card closure",
      ...(bulk ? { changes, count: changes.length } : changes[0]),
      affectedChargeIds,
      invalidatedDecisionIds,
    },
  );
}
