export const isReconciled = (status: string) =>
  ["Matched", "Matched with flags", "Confirmed"].includes(status);
export const isReviewed = (status: string) =>
  isReconciled(status) || ["No PO required", "Dismissed"].includes(status);
export const needsReview = (status: string) =>
  !isReviewed(status) && status !== "Outside card coverage";
