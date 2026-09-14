import type { RecordItem } from "./domain";

export const LOWES_DESCRIPTION_RULE = "qbo-lowes-store-v1";

// Recognize the complete, observed store descriptor, never an arbitrary mention
// of Lowe's in a note. Repeated descriptors must all identify the same merchant.
const lowesStores =
  /^(?:LOWE['’]?S\s+#X?\d{1,8}\*?)(?:\s+LOWE['’]?S\s+#X?\d{1,8}\*?)*$/i;

export function resolveVendorDescription(record: RecordItem): RecordItem {
  if (record.source !== "qbo" || !record.vendorMissing) return record;
  if (!lowesStores.test(record.description.trim())) return record;
  const { vendorMissing: _missing, ...rest } = record;
  return {
    ...rest,
    vendor: "Lowe's",
    vendorEvidence: {
      source: "QuickBooks.PrivateNote",
      text: record.description,
      rule: LOWES_DESCRIPTION_RULE,
    },
  };
}

export function vendorDisplay(record: RecordItem): string {
  return record.vendorMissing && record.description.trim()
    ? `Description: ${record.description.trim()}`
    : record.vendor;
}

export function vendorBasis(record: RecordItem): string {
  if (record.vendorEvidence)
    return "Recognized from QuickBooks description; payee not assigned";
  if (record.vendorMissing)
    return "QuickBooks payee not assigned; vendor unverified";
  return record.source === "qbo" ? "QuickBooks payee" : "ServiceTitan vendor";
}
