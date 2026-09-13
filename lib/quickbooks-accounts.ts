import type { QuickBooksAccount } from "./domain";
export function cardDescendants(accounts: QuickBooksAccount[], parent: string) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return accounts.filter((a) => {
    if (!a.subAccount || a.id === parent) return false;
    let id = a.parentId;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      if (id === parent) return true;
      seen.add(id);
      id = byId.get(id)?.parentId;
    }
    return false;
  });
}
