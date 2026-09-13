import type { RecordItem, State } from "./domain";
export function applyOwnership(
  records: RecordItem[],
  state: Pick<State, "cardAssignments" | "cardMappings">,
): RecordItem[] {
  const mappings = new Map<
    string,
    NonNullable<State["cardMappings"]>[number]
  >();
  for (const mapping of state.cardMappings || []) {
    if (mappings.has(mapping.accountId))
      throw Error(
        "Multiple mappings exist for the same card. Resolve the duplicate mappings before reconciling.",
      );
    mappings.set(mapping.accountId, mapping);
  }
  return records.map((r) => {
    if (r.source !== "qbo") return r;
    const importedCardUser = r.importedCardUser ?? r.cardUser ?? "Unassigned";
    const importedOwnershipSource =
      r.importedOwnershipSource ?? r.ownershipSource ?? "Unassigned";
    const mapping = r.accountId ? mappings.get(r.accountId) : undefined;
    const manual = state.cardAssignments?.[r.id];
    return {
      ...r,
      importedCardUser,
      importedOwnershipSource,
      cardUser: manual || mapping?.cardUser || importedCardUser,
      cardPersonId: manual ? undefined : mapping?.personId,
      ownershipSource: manual
        ? "Manual assignment"
        : mapping
          ? "Verified subaccount mapping"
          : importedOwnershipSource,
    };
  });
}
