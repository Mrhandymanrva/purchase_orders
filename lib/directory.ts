import type { State, CardMapping } from "./domain";
export function accountOptions(state: State) {
  const options = new Map(
    (state.directory?.accounts || []).map((a) => [a.id, a]),
  );
  for (const r of state.records)
    if (r.source === "qbo" && r.accountId && !options.has(r.accountId))
      options.set(r.accountId, {
        id: r.accountId,
        name: r.account,
        active: true,
      });
  for (const m of state.cardMappings || [])
    if (!options.has(m.accountId))
      options.set(m.accountId, {
        id: m.accountId,
        name: m.accountName || m.accountId,
        active: true,
      });
  return [...options.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}
export function resolvePerson(
  state: State,
  name: string,
  id?: string,
  prior?: CardMapping,
) {
  const people = state.directory?.people || [];
  if (id) {
    const person = people.find((p) => p.id === id);
    if (!person) {
      if (id === prior?.personId && name === prior.cardUser)
        return { cardUser: name, personId: id };
      throw Error("ServiceTitan person was not found. Refresh the dropdowns.");
    }
    if (!person.active && id !== prior?.personId)
      throw Error("Select an active ServiceTitan person for a new assignment.");
    if (
      name.trim().toLowerCase() !== person.name.toLowerCase() &&
      !(prior?.personId === id && prior.cardUser === name)
    )
      throw Error(
        "Card user and ST Person ID disagree. Select the correct person or clear the old ST Person ID.",
      );
    return { cardUser: person.name, personId: id };
  }
  if (prior?.personId && name === prior.cardUser)
    return { cardUser: name, personId: prior.personId };
  const matches = people.filter(
    (p) => p.name.toLowerCase() === name.trim().toLowerCase(),
  );
  if (matches.length > 1)
    throw Error(
      "Employee name is ambiguous. Select the ServiceTitan person by ID in the assignment grid.",
    );
  if (matches.length === 1 && !matches[0].active)
    throw Error("Select an active ServiceTitan person for a new assignment.");
  return {
    cardUser: name,
    personId: matches.length === 1 ? matches[0].id : undefined,
  };
}
