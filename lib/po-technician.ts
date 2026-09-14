import type { RecordItem, Result, State } from "./domain";

/** Resolve the PO's own ST identity, never the matched card owner's identity. */
export function poTechnician(state: State, po: RecordItem) {
  if (!po.technicianId)
    return {
      id: "",
      name: "Technician not specified",
      basis: "No technician ID on the imported PO",
    };
  const id = `technician:${po.technicianId}`;
  const person = state.directory?.people.find(
    (p) => p.kind === "technician" && p.id === id,
  );
  if (person)
    return {
      id,
      name: person.name,
      basis: "ServiceTitan technician directory",
    };
  // Saved mappings retain the known name when a person leaves the active directory.
  const savedNames = [
    ...new Set(
      (state.cardMappings || [])
        .filter((m) => m.personId === id)
        .map((m) => m.cardUser.trim())
        .filter(Boolean),
    ),
  ];
  if (savedNames.length === 1)
    return {
      id,
      name: savedNames[0],
      basis: "Saved ST identity from card mapping",
    };
  return {
    id,
    name: `ST technician #${po.technicianId}`,
    basis: "Name unavailable in the active ST directory",
  };
}
export function poTechnicians(state: State, result: Result) {
  return [
    ...new Set(
      result.pos
        .map((id) => state.records.find((r) => r.id === id))
        .filter((p): p is RecordItem => !!p)
        .map((p) => poTechnician(state, p).name),
    ),
  ].sort();
}
export function poTechnicianLabel(state: State, result: Result) {
  return poTechnicians(state, result).join(", ") || "—";
}
export function individualMatches(
  state: State | undefined,
  id: string | undefined,
  name: string,
  individual?: string,
) {
  if (!individual || individual === "All individuals" || name === individual)
    return true;
  if (!state || !id) return false;
  return (
    (state.directory?.people || []).some(
      (p) => p.id === id && p.name === individual,
    ) ||
    (state.cardMappings || []).some(
      (m) => m.personId === id && m.cardUser === individual,
    ) ||
    state.records.some(
      (r) =>
        r.source === "qbo" &&
        r.cardPersonId === id &&
        r.cardUser === individual,
    )
  );
}
export function reconciliationIndividuals(state: State) {
  return [
    ...new Set(
      state.records.map((r) =>
        r.source === "qbo"
          ? r.cardUser || "Unassigned"
          : poTechnician(state, r).name,
      ),
    ),
  ].sort((a, b) => a.localeCompare(b));
}
