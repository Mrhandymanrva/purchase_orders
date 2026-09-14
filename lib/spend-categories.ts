import type { State, Result, SpendCategory } from "./domain";
export const defaultSpendCategories: SpendCategory[] = [
  { id: "office", name: "Office", active: true },
  {
    id: "non-billable-materials",
    name: "Non-Billable Materials",
    active: true,
  },
  { id: "tools", name: "Tools", active: true },
];
export const spendCategories = (state: Pick<State, "spendCategories">) =>
  state.spendCategories ?? defaultSpendCategories;
export function spendCategoryLabel(
  state: Pick<State, "spendCategories">,
  result: Pick<Result, "categoryId" | "categoryName">,
) {
  if (!result.categoryId) return "";
  return (
    spendCategories(state).find((c) => c.id === result.categoryId)?.name ||
    result.categoryName ||
    "Archived category"
  );
}
