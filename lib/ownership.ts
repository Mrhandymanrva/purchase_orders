import type { RecordItem, State } from "./domain";
export function applyOwnership(
  records: RecordItem[],
  state: Pick<State, "cardAssignments" | "cardMappings">,
): RecordItem[] {
  return records.map((r) => {
    if (r.source !== "qbo") return r;
    const importedCardUser = r.importedCardUser ?? r.cardUser ?? "Unassigned";
    const importedOwnershipSource =
      r.importedOwnershipSource ?? r.ownershipSource ?? "Unassigned";
    const mapping = (state.cardMappings || []).find(
      (m) =>
        m.accountId === r.accountId &&
        m.from <= r.date &&
        (!m.through || m.through >= r.date),
    );
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
