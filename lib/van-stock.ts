import type { RecordItem, State } from "./domain";

export const VAN_STOCK_RULE = "st-explicit-label-v1";
const normalize = (value: string) =>
  value.trim().replace(/\s+/g, " ").toUpperCase();
export const isVanStockTypeName = (name: string) =>
  /^(VAN STOCK|VS)$/.test(normalize(name));

// A label must lead the field. Whole tokens avoid matching "VS123" or
// "van stockroom"; prose such as "compare A vs B" is not a label.
const leadingLabel =
  /^\s*(?:\[(VAN\s+STOCK|VS)\](?=$|[\s:|/\-–—])|(VAN\s+STOCK|VS)(?=$|[\s:|/\-–—]))/i;

export function classifyVanStock(record: RecordItem, state: State) {
  const result = (
    vanStock: boolean,
    basis: string,
    label = "",
    unknownType = false,
  ) => ({ vanStock, basis, label, unknownType, rule: VAN_STOCK_RULE });
  if (record.source !== "st") return result(false, "Not a ServiceTitan PO");
  const type = state.directory?.poTypes.find((t) => t.id === record.poTypeId);
  if (type && isVanStockTypeName(type.name))
    return result(true, "ServiceTitan PO type", type.name);
  for (const [field, value] of [
    ["ServiceTitan PO number", record.reference],
    ["ServiceTitan PO summary", record.description],
  ]) {
    const match = value.match(leadingLabel);
    if (match) return result(true, field, normalize(match[1] || match[2]));
  }
  if (record.poTypeId && state.vanStockTypeIds?.includes(record.poTypeId))
    return result(
      true,
      "Approved additional PO type",
      type?.name || record.poTypeId,
    );
  return result(
    false,
    type
      ? "No VAN STOCK / VS label or approved type"
      : "No VAN STOCK / VS label; PO type unavailable",
    type?.name || "",
    !type,
  );
}
