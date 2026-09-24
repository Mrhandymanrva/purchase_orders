import type { State, Result } from "./domain";
export function jobContext(
  state: State,
  result: Result,
  field: "customerName" | "jobId" | "jobNumber",
) {
  return [
    ...new Set(
      result.pos
        .map((id) => state.records.find((p) => p.id === id)?.[field])
        .filter((value): value is string => !!value),
    ),
  ].join("; ");
}

export function purchaseOrderLabel(state: State, result: Result) {
  return result.pos
    .map((id) => {
      const po = state.records.find((p) => p.id === id);
      return po?.reference || "ID: " + id;
    })
    .join("; ");
}
