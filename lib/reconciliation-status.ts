// Keep stored status keys stable while presenting clearer wording to operators.
export const statusLabel = (status: string) =>
  status === "Payee not assigned" ? "Vendor needs confirmation" : status;
export const isReconciled = (status: string) =>
  ["Matched", "Matched with flags", "Confirmed"].includes(status);
export const isReviewed = (status: string) =>
  isReconciled(status) || ["No PO required", "Dismissed"].includes(status);
export const needsReview = (status: string) =>
  !isReviewed(status) && status !== "Outside card coverage";
