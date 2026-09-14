import {
  configSchema,
  recordSchema,
  calendarDate,
  type RecordItem,
  type Config,
  type Rule,
  type Result,
  type Decision,
  type State,
} from "./domain";
export const ENGINE_VERSION = "1.0.2";
export function normalize(v: string, rules: Rule[] = []): string {
  const clean = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const key = clean(v);
  const alias = rules.find(
    (r) => r.approved && r.type === "alias" && clean(r.pattern) === key,
  );
  return clean(alias ? alias.target : v);
}
const days = (a: string, b: string) =>
  Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const sum = (rs: RecordItem[]) => rs.reduce((n, r) => n + r.amount, 0);
export function fingerprint(records: RecordItem[], ids: string[]): string {
  return JSON.stringify(
    records
      .filter((r) => ids.includes(r.id))
      .map((r) => ({
        ...recordSchema.parse(r),
        cardUser: r.cardUser || "Unassigned",
        ownershipSource: r.ownershipSource || "",
        ...(r.cardPersonId ? { cardPersonId: r.cardPersonId } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}
function idFor(q: RecordItem[], p: RecordItem[]) {
  return JSON.stringify([q.map((r) => r.id).sort(), p.map((r) => r.id).sort()]);
}
function combinations<T>(arr: T[], max: number): T[][] {
  const out: T[][] = [];
  function walk(start: number, group: T[]) {
    if (group.length >= 2) out.push(group);
    if (group.length === max) return;
    for (let i = start; i < arr.length; i++) walk(i + 1, [...group, arr[i]]);
  }
  walk(0, []);
  return out;
}
export function reconcile(
  input: RecordItem[],
  policy: Config,
  rules: Rule[],
  asOf: string,
  decisions: Decision[] = [],
  coverage?: State["coverage"],
): Result[] {
  const config = configSchema.parse(policy);
  if (coverage) {
    calendarDate.parse(coverage.chargesFrom);
    calendarDate.parse(coverage.through);
    if (coverage.chargesFrom > coverage.through)
      throw Error("Card history coverage starts after its end date");
  }
  const records = input
    .map((r) => ({
      ...recordSchema.parse(r),
      cardUser: r.cardUser,
      cardPersonId: r.cardPersonId,
      ownershipSource: r.ownershipSource,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(records.map((r) => r.id)).size !== records.length)
    throw Error("Source IDs must be unique");
  const charges = records.filter((r) => r.source === "qbo"),
    pos = records.filter((r) => r.source === "st");
  const consumed = new Set<string>();
  const output: Result[] = [];
  function result(
    q: RecordItem[],
    p: RecordItem[],
    status: string,
    score: number,
    reasons: string[],
    flags: string[] = [],
  ): Result {
    return {
      id: idFor(q, p),
      status,
      charges: q.map((r) => r.id),
      pos: p.map((r) => r.id),
      vendor: (q[0] || p[0]).vendor,
      amount: q.length ? sum(q) : sum(p),
      difference: sum(q) - sum(p),
      date: (q[0] || p[0]).date,
      score,
      reasons,
      flags,
      kind:
        q.length > 1
          ? "many:1"
          : p.length > 1
            ? "1:many"
            : q.length && p.length
              ? "1:1"
              : q.length
                ? "Card purchase"
                : "Purchase order",
    };
  }
  // Explicit decisions reserve records only while their complete evidence snapshot is unchanged.
  for (const d of decisions.slice().reverse()) {
    const ids = [...d.charges, ...d.pos];
    if (
      ids.some((id) => consumed.has(id)) ||
      fingerprint(records, ids) !== d.fingerprint
    )
      continue;
    const q = charges.filter((r) => d.charges.includes(r.id)),
      p = pos.filter((r) => d.pos.includes(r.id));
    if (!q.length && !p.length) continue;
    output.push(
      result(q, p, d.action === "confirm" ? "Confirmed" : "Dismissed", 0, [
        `Manual ${d.action} by ${d.actor}: ${d.reason}`,
        `Recorded ${d.at}; source fingerprint verified.`,
      ]),
    );
    ids.forEach((id) => consumed.add(id));
  }
  // Missing vendor identity is a review exception, never evidence for a match or exemption.
  for (const r of records.filter(
    (r) => r.vendorMissing && !consumed.has(r.id),
  )) {
    output.push(
      result(
        r.source === "qbo" ? [r] : [],
        r.source === "st" ? [r] : [],
        "Missing vendor",
        0,
        [
          "The source record has no vendor name. Automatic matching and No-PO exemptions are disabled.",
          "Add the vendor in the source system and sync again, or record an explicit manual review.",
        ],
        r.amount < 0 ? ["Unallocated refund / credit"] : [],
      ),
    );
    consumed.add(r.id);
  }
  const duplicate = new Set<string>();
  for (const q of charges.filter((r) => !r.vendorMissing)) {
    if (
      charges.some(
        (o) =>
          o.id !== q.id &&
          !o.vendorMissing &&
          o.amount === q.amount &&
          o.date === q.date &&
          normalize(o.vendor, rules) === normalize(q.vendor, rules) &&
          (o.accountId || o.account) === (q.accountId || q.account),
      )
    )
      duplicate.add(q.id);
  }
  // No-PO exemptions never mask possible duplicates and never apply to refunds.
  for (const q of charges.filter(
    (r) => !consumed.has(r.id) && !duplicate.has(r.id),
  )) {
    const rule = rules.find(
      (r) =>
        r.approved &&
        r.type === "no-po" &&
        normalize(r.pattern, rules) === normalize(q.vendor, rules) &&
        q.amount > 0 &&
        q.amount <= r.maxCents,
    );
    if (rule) {
      output.push(
        result([q], [], "No PO required", 0, [
          `Approved rule ${rule.id}: ${rule.description}`,
          `Amount within ${rule.maxCents} cent limit.`,
        ]),
      );
      consumed.add(q.id);
    }
  }
  type Candidate = {
    q: RecordItem[];
    p: RecordItem[];
    score: number;
    reasons: string[];
    flags: string[];
    exact: boolean;
  };
  const candidates: Candidate[] = [];
  const bounded = new Set<string>();
  const compatible = (q: RecordItem, p: RecordItem) =>
    normalize(q.vendor, rules) === normalize(p.vendor, rules) &&
    q.currency === p.currency &&
    Math.sign(q.amount) === Math.sign(p.amount) &&
    Math.abs(days(q.date, p.date)) <= config.windowDays;
  function propose(q: RecordItem[], p: RecordItem[]) {
    if (q.some((a) => p.some((b) => !compatible(a, b)))) return;
    const delta = Math.abs(sum(q) - sum(p));
    const exact = delta <= config.toleranceCents;
    const ref = q.every(
      (a) =>
        a.reference &&
        p.some((b) => b.reference === a.reference || b.id === a.reference),
    );
    if (!exact && !ref) return;
    if ((q.length > 1 || p.length > 1) && !exact) return;
    const dateGap = Math.max(
      ...q.flatMap((a) => p.map((b) => Math.abs(days(a.date, b.date)))),
    );
    const datePoints = Math.round(
      config.weights.date * (1 - dateGap / (config.windowDays + 1)),
    );
    const amountPoints = exact
      ? config.weights.amount
      : Math.round(
          config.weights.amount *
            Math.max(0, 1 - delta / Math.max(1, Math.abs(sum(p)))),
        );
    const score = Math.min(
      100,
      config.weights.vendor +
        amountPoints +
        datePoints +
        (ref ? config.weights.reference : 0),
    );
    if (candidates.length >= 20000)
      throw Error(
        "Candidate limit reached; narrow the sync date range or vendor policy",
      );
    const referenceConflict = q.some(
      (a) =>
        a.reference &&
        !p.some((b) => b.reference === a.reference || b.id === a.reference),
    );
    const late = p.some((b) =>
      q.some(
        (a) =>
          days((b.createdAt || b.date).slice(0, 10), a.date) > config.lateDays,
      ),
    );
    candidates.push({
      q,
      p,
      score,
      exact,
      flags: [
        ...(referenceConflict ? ["PO reference conflict"] : []),
        ...(late ? ["Late PO"] : []),
        ...(sum(q) < 0 ? ["Refund / credit"] : []),
      ],
      reasons: [
        `Exact normalized vendor: ${normalize(q[0].vendor, rules)} (+${config.weights.vendor}).`,
        `Amount difference ${delta} cents (+${amountPoints}).`,
        `Maximum date gap ${dateGap} days (+${datePoints}).`,
        ref
          ? `Reference agrees (+${config.weights.reference}).`
          : "No shared PO reference (+0).",
        `Policy: threshold ${config.autoThreshold}, tolerance ${config.toleranceCents} cents. Engine ${ENGINE_VERSION}.`,
      ],
    });
  }
  const availableQ = charges.filter((r) => !consumed.has(r.id)),
    availableP = pos.filter((r) => !consumed.has(r.id));
  for (const q of availableQ) {
    const eligible = availableP.filter((p) => compatible(q, p));
    eligible.forEach((p) => propose([q], [p]));
    if (eligible.length > 14) {
      bounded.add(q.id);
      continue;
    }
    combinations(eligible, config.maxGroup).forEach((group) =>
      propose([q], group),
    );
  }
  for (const p of availableP) {
    const eligible = availableQ.filter((q) => compatible(q, p));
    if (eligible.length > 14) {
      bounded.add(p.id);
      continue;
    }
    combinations(eligible, config.maxGroup).forEach((group) =>
      propose(group, [p]),
    );
  }
  candidates.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      b.score - a.score ||
      idFor(a.q, a.p).localeCompare(idFor(b.q, b.p)),
  );
  const ids = (c: Candidate) => [...c.q, ...c.p].map((r) => r.id);
  for (const c of candidates) {
    if (ids(c).some((id) => consumed.has(id))) continue;
    const overlap = candidates.some(
      (o) =>
        o !== c &&
        o.exact === c.exact &&
        Math.abs(o.score - c.score) <= config.ambiguityMargin &&
        ids(o).some((id) => ids(c).includes(id)) &&
        !ids(o).some((id) => consumed.has(id)),
    );
    const dup = c.q.some((q) => duplicate.has(q.id));
    const truncated = ids(c).some((id) => bounded.has(id));
    let status = dup
      ? "Possible duplicate"
      : overlap
        ? "Ambiguous"
        : truncated || c.flags.includes("PO reference conflict")
          ? "Needs review"
          : !c.exact
            ? Math.abs(sum(c.q)) < Math.abs(sum(c.p))
              ? "Partial match"
              : "Amount mismatch"
            : c.flags.includes("Late PO")
              ? "Late PO"
              : c.score >= config.autoThreshold
                ? "Matched"
                : "Needs review";
    output.push(
      result(
        c.q,
        c.p,
        status,
        c.score,
        [
          ...c.reasons,
          ...(overlap
            ? [
                "Competing candidates overlap within the ambiguity margin; human review required.",
              ]
            : []),
          ...(dup
            ? [
                "Same vendor, account, date and amount appears on another charge.",
              ]
            : []),
          ...(truncated
            ? [
                "Group search exceeded 14 candidates; automatic matching disabled.",
              ]
            : []),
        ],
        c.flags,
      ),
    );
    ids(c).forEach((id) => consumed.add(id));
  }
  for (const q of availableQ.filter((r) => !consumed.has(r.id))) {
    output.push(
      result(
        [q],
        [],
        duplicate.has(q.id)
          ? "Possible duplicate"
          : days(asOf, q.date) > config.graceDays
            ? "Missing PO"
            : "Awaiting PO",
        0,
        [
          duplicate.has(q.id)
            ? "Another charge has the same vendor, account, date and amount."
            : "No available compatible purchase order found.",
          `Grace period: ${config.graceDays} days.`,
        ],
        q.amount < 0 ? ["Unallocated refund / credit"] : [],
      ),
    );
  }
  for (const p of availableP.filter((r) => !consumed.has(r.id))) {
    const outsideCoverage =
      coverage && (p.date < coverage.chargesFrom || p.date > coverage.through);
    output.push(
      result(
        [],
        [p],
        outsideCoverage
          ? "Outside card coverage"
          : days(asOf, p.date) > config.graceDays
            ? "PO without charge"
            : "Awaiting charge",
        0,
        outsideCoverage
          ? [
              `This PO is dated ${p.date}; imported card history covers ${coverage.chargesFrom} through ${coverage.through}.`,
              "Retained for matching and reporting. Payment cannot be assessed from the available card history; this is excluded from review counts and unresolved variance.",
            ]
          : [
              "No available compatible posted card purchase in the imported selected card accounts.",
              `Grace period: ${config.graceDays} days.`,
            ],
      ),
    );
  }
  return output.sort(
    (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
  );
}
