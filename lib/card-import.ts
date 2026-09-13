import { z } from "zod";
import { type CardMapping, type State } from "./domain";
import { resolvePerson } from "./directory";
export const importRowSchema = z.object({
  row: z.number().int().positive(),
  id: z.string().trim().max(100).optional(),
  personId: z.string().trim().max(100).optional(),
  accountId: z.string().trim().max(100).optional(),
  accountName: z.string().trim().max(150).optional(),
  cardUser: z.string().trim().min(2).max(100),
  // Accept old template columns for compatibility; dates have no effect.
  from: z.string().optional(),
  through: z.string().optional(),
  reason: z.string().trim().min(5).max(500).optional(),
});
export type ImportRow = z.infer<typeof importRowSchema>;
export type ImportChange = {
  row: number | null;
  kind: "new" | "updated" | "unchanged" | "closed";
  before: CardMapping | null;
  after: CardMapping;
};
export type ImportPlan = {
  errors: { row: number; message: string }[];
  changes: ImportChange[];
  mappings: CardMapping[];
  counts: Record<ImportChange["kind"], number>;
};
export function knownAccounts(
  state: Pick<State, "records" | "cardMappings" | "directory">,
) {
  const accounts = new Map<string, Set<string>>();
  const add = (id: string, name: string) => {
    const labels = accounts.get(id) || new Set<string>();
    if (name) labels.add(name.trim());
    accounts.set(id, labels);
  };
  for (const m of state.cardMappings || [])
    add(m.accountId, m.accountName || "");
  for (const a of state.directory?.accounts || []) add(a.id, a.name);
  for (const r of state.records)
    if (r.source === "qbo" && r.accountId) add(r.accountId, r.account);
  return accounts;
}
const blank = (v: string | undefined) => v?.trim() || undefined;
export function planMappingImport(
  state: State,
  input: ImportRow[],
  uploadReason: string,
  parentId?: string,
): ImportPlan {
  const errors: ImportPlan["errors"] = [],
    changes: ImportChange[] = [],
    counts = { new: 0, updated: 0, unchanged: 0, closed: 0 };
  const existing = state.cardMappings || [],
    accounts = knownAccounts(state);
  if (new Set(existing.map((m) => m.accountId)).size !== existing.length)
    errors.push({
      row: 0,
      message:
        "Existing mappings contain duplicate cards. Resolve them before importing.",
    });
  const plan: CardMapping[] = existing.map((m) => ({ ...m }));
  const seen = new Set<string>(),
    touched = new Map<string, number>();
  const parsed: ImportRow[] = [];
  for (const candidate of input) {
    const p = importRowSchema.safeParse(candidate);
    if (!p.success) {
      errors.push({
        row: candidate.row,
        message: p.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
      continue;
    }
    parsed.push(p.data);
  }
  // Resolve identity before changing any record. Names are allowed only when exactly one account matches.
  const resolved: { row: ImportRow; accountId: string; old?: CardMapping }[] =
    [];
  for (const row of parsed) {
    let accountId = blank(row.accountId);
    const id = blank(row.id);
    const oldById = id ? existing.find((m) => m.id === id) : undefined;
    if (id && !oldById) {
      errors.push({
        row: row.row,
        message:
          "Mapping ID was not found. Export the current mappings and retry.",
      });
      continue;
    }
    if (!accountId && oldById) accountId = oldById.accountId;
    if (!accountId && row.accountName) {
      const matches = [...accounts].filter(([, names]) =>
        [...names].some(
          (n) => n.toLowerCase() === row.accountName!.trim().toLowerCase(),
        ),
      );
      if (matches.length !== 1) {
        errors.push({
          row: row.row,
          message: matches.length
            ? "Subaccount name is ambiguous; supply its QuickBooks ID."
            : "Subaccount name was not found; supply its QuickBooks ID or sync first.",
        });
        continue;
      }
      accountId = matches[0][0];
    }
    if (!accountId) {
      errors.push({
        row: row.row,
        message:
          "Subaccount ID or a uniquely known subaccount name is required.",
      });
      continue;
    }
    if (accountId === parentId) {
      errors.push({
        row: row.row,
        message:
          "The parent credit-card account cannot be assigned to one person.",
      });
      continue;
    }
    if (oldById && oldById.accountId !== accountId) {
      errors.push({
        row: row.row,
        message:
          "An existing Mapping ID cannot move to a different subaccount.",
      });
      continue;
    }
    const old = oldById || existing.find((m) => m.accountId === accountId);
    const key = accountId;
    if (seen.has(key)) {
      errors.push({
        row: row.row,
        message: "Duplicate card in this file: use one row per subaccount.",
      });
      continue;
    }
    seen.add(key);
    resolved.push({ row, accountId, old });
  }
  for (const { row, accountId, old } of resolved) {
    let person;
    try {
      person = resolvePerson(state, row.cardUser, row.personId, old);
    } catch (e) {
      errors.push({
        row: row.row,
        message: e instanceof Error ? e.message : "Invalid employee",
      });
      continue;
    }
    const candidate: CardMapping = {
      id: old?.id || `import:${JSON.stringify(accountId)}`,
      accountId,
      accountName:
        blank(row.accountName) ||
        old?.accountName ||
        [...(accounts.get(accountId) || [])][0] ||
        undefined,
      ...person,
      reason: blank(row.reason) || old?.reason || uploadReason,
    };
    if (old)
      plan.splice(
        plan.findIndex((m) => m.id === old.id),
        1,
        candidate,
      );
    else plan.push(candidate);
    touched.set(candidate.id, row.row);
  }
  const equal = (a: CardMapping, b: CardMapping) =>
    a.accountId === b.accountId &&
    (a.accountName || "") === (b.accountName || "") &&
    a.cardUser === b.cardUser &&
    (a.personId || "") === (b.personId || "") &&
    a.reason === b.reason;
  for (const after of plan) {
    const before = existing.find((m) => m.id === after.id) || null;
    const row = touched.get(after.id);
    if (row !== undefined) {
      const kind = !before
        ? "new"
        : equal(before, after)
          ? "unchanged"
          : "updated";
      changes.push({ row, kind, before, after });
      counts[kind]++;
    } else if (before && !equal(before, after)) {
      changes.push({ row: null, kind: "closed", before, after });
      counts.closed++;
    }
  }
  changes.sort(
    (a, b) =>
      (a.row ?? Number.MAX_SAFE_INTEGER) - (b.row ?? Number.MAX_SAFE_INTEGER),
  );
  return { errors, changes, mappings: plan, counts };
}
