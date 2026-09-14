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
import { vendorDisplay } from "./vendor-evidence";
import { descriptionKey, ruleMatchField } from "./vendor-rule";
export const ENGINE_VERSION = "1.3.0";
export function decisionFitsPolicy(
  decision: Pick<Decision, "charges" | "pos">,
  policy: Config,
) {
  return (
    policy.maxGroup !== 1 ||
    (decision.charges.length <= 1 && decision.pos.length <= 1)
  );
}
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
export function sameRuleMatch(
  a: Pick<Rule, "type" | "pattern" | "matchField">,
  b: Pick<Rule, "type" | "pattern" | "matchField">,
  rules: Rule[] = [],
) {
  if (a.type !== b.type || ruleMatchField(a) !== ruleMatchField(b))
    return false;
  return ruleMatchField(a) === "description"
    ? descriptionKey(a.pattern) === descriptionKey(b.pattern)
    : normalize(a.pattern, a.type === "no-po" ? rules : []) ===
        normalize(b.pattern, b.type === "no-po" ? rules : []);
}
export function noPORuleApplies(record: RecordItem, rule: Rule, rules: Rule[]) {
  if (
    record.source !== "qbo" ||
    !rule.approved ||
    rule.type !== "no-po" ||
    record.amount <= 0 ||
    (rule.maxCents !== null && record.amount > rule.maxCents)
  )
    return false;
  return ruleMatchField(rule) === "description"
    ? !!record.vendorMissing &&
        !!descriptionKey(record.description) &&
        descriptionKey(rule.pattern) === descriptionKey(record.description)
    : !record.vendorMissing &&
        !!normalize(rule.pattern, rules) &&
        normalize(rule.pattern, rules) === normalize(record.vendor, rules);
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
// Positive magnitudes permit amount pruning. Work and output are bounded per
// anchor; exceeding the budget becomes an explicit flag, never a silent cutoff.
function balancedGroups(
  items: RecordItem[],
  target: number,
  max: number,
  tolerance: number,
) {
  const high = Math.abs(target) + tolerance,
    low = Math.max(0, Math.abs(target) - tolerance);
  const sorted = items
    .filter((r) => Math.abs(r.amount) > 0 && Math.abs(r.amount) <= high)
    .sort(
      (a, b) =>
        Math.abs(a.amount) - Math.abs(b.amount) || a.id.localeCompare(b.id),
    );
  const groups: RecordItem[][] = [];
  let visited = 0,
    limited = false;
  function walk(start: number, group: RecordItem[], total: number) {
    if (group.length >= 2 && total >= low && total <= high) {
      groups.push(group);
      if (groups.length >= 200) {
        limited = true;
        return;
      }
    }
    if (group.length === max || limited) return;
    const slots = max - group.length;
    const largest = sorted
      .slice(Math.max(start, sorted.length - slots))
      .reduce((n, r) => n + Math.abs(r.amount), 0);
    if (total + largest < low) return;
    for (let i = start; i < sorted.length; i++) {
      if (++visited > 20000) {
        limited = true;
        return;
      }
      const next = total + Math.abs(sorted[i].amount);
      if (next > high) break;
      walk(i + 1, [...group, sorted[i]], next);
      if (limited) return;
    }
  }
  walk(0, [], 0);
  return { groups, limited };
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
  const matchAndFlag = config.automationMode === "match-and-flag";
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
      vendor: vendorDisplay(q[0] || p[0]),
      amount: q.length ? sum(q) : sum(p),
      difference: sum(q) - sum(p),
      date: (q[0] || p[0]).date,
      score,
      reasons: [
        ...q
          .filter((r) => r.vendorEvidence)
          .map(
            (r) =>
              `${r.id}: ${r.vendor} recognized from QuickBooks description "${r.vendorEvidence!.text}" (${r.vendorEvidence!.rule}). The QuickBooks payee field is unassigned.`,
          ),
        ...reasons,
      ],
      flags,
      kind:
        q.length > 1
          ? "many:1"
          : p.length > 1
            ? "1:many"
            : q.length && p.length
              ? "1:1"
              : q.length
                ? sum(q) < 0
                  ? "Card refund / credit"
                  : "Card purchase"
                : "Purchase order",
    };
  }
  // Explicit decisions reserve records only while their complete evidence snapshot is unchanged.
  for (const d of decisions.slice().reverse()) {
    const ids = [...d.charges, ...d.pos];
    if (
      !decisionFitsPolicy(d, config) ||
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
  const duplicate = new Set<string>();
  const identity = (r: RecordItem) =>
    r.vendorMissing
      ? descriptionKey(r.description)
        ? "description:" + descriptionKey(r.description)
        : ""
      : "vendor:" + normalize(r.vendor, rules);
  for (const q of charges) {
    const key = identity(q);
    if (
      key &&
      charges.some(
        (o) =>
          o.id !== q.id &&
          identity(o) === key &&
          o.amount === q.amount &&
          o.date === q.date &&
          (o.accountId || o.account) === (q.accountId || q.account),
      )
    )
      duplicate.add(q.id);
  }
  // Explicit description exemptions are distinct from vendor identification.
  // They never change imported payees or provide evidence for an automatic PO link.
  for (const q of charges.filter(
    (r) => !consumed.has(r.id) && !duplicate.has(r.id),
  )) {
    const rule = rules.find((r) => noPORuleApplies(q, r, rules));
    if (rule) {
      output.push(
        result([q], [], "No PO required", 0, [
          `Approved rule ${rule.id}: ${rule.description}`,
          ruleMatchField(rule) === "description"
            ? `Explicitly approved full QuickBooks description: "${rule.pattern}". Payee remains unassigned; no vendor identity was inferred.`
            : `Approved vendor exemption: ${rule.pattern}.`,
          rule.maxCents === null
            ? "Approved merchant exemption has no amount limit."
            : `Amount within ${rule.maxCents} cent limit.`,
        ]),
      );
      consumed.add(q.id);
    }
  }
  for (const r of records.filter(
    (r) => r.vendorMissing && !consumed.has(r.id),
  )) {
    output.push(
      result(
        r.source === "qbo" ? [r] : [],
        r.source === "st" ? [r] : [],
        duplicate.has(r.id)
          ? "Possible duplicate"
          : r.description.trim()
            ? "Payee not assigned"
            : "Missing vendor",
        0,
        [
          r.description.trim()
            ? "QuickBooks has no assigned payee. Automatic PO matching is disabled. An explicit full-description No-PO rule can exempt eligible purchases."
            : "The source has no usable vendor identity. Automatic matching and vendor exemptions are disabled.",
          ...(duplicate.has(r.id)
            ? [
                "Another charge has the same description, account, date and amount. No-PO rules do not hide possible duplicates.",
              ]
            : []),
          "Review the source evidence or create a rule from the detail panel.",
        ],
        r.amount < 0 ? ["Unallocated refund / credit"] : [],
      ),
    );
    consumed.add(r.id);
  }
  type Candidate = {
    q: RecordItem[];
    p: RecordItem[];
    score: number;
    reasons: string[];
    flags: string[];
    exact: boolean;
    key: string;
    ids: string[];
    dateGap: number;
    referenceMatch: boolean;
    identity: number;
  };
  const candidates: Candidate[] = [];
  const bounded = new Set<string>();
  const compatible = (q: RecordItem, p: RecordItem) =>
    normalize(q.vendor, rules) === normalize(p.vendor, rules) &&
    q.currency === p.currency &&
    Math.sign(q.amount) === Math.sign(p.amount) &&
    Math.abs(days(q.date, p.date)) <= config.windowDays;
  function propose(q: RecordItem[], p: RecordItem[]) {
    if (q.length > config.maxGroup || p.length > config.maxGroup) return;
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
    if (candidates.length >= 20000) {
      if (matchAndFlag && (q.length > 1 || p.length > 1)) {
        [...q, ...p].forEach((r) => bounded.add(r.id));
        return;
      }
      throw Error(
        "Candidate limit reached; narrow the sync date range or vendor policy",
      );
    }
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
    const cardPeople = new Set(
      q
        .map((r) => r.cardPersonId)
        .filter((id): id is string => !!id && id.startsWith("technician:")),
    );
    const poPeople = new Set(
      p
        .filter((r) => r.technicianId)
        .map((r) => `technician:${r.technicianId}`),
    );
    const identitiesKnown =
      q.every((r) => r.cardPersonId?.startsWith("technician:")) &&
      p.every((r) => r.technicianId);
    const identity = identitiesKnown
      ? cardPeople.size === poPeople.size &&
        [...cardPeople].every((id) => poPeople.has(id))
        ? 1
        : -1
      : 0;
    candidates.push({
      q,
      p,
      score,
      exact,
      key: idFor(q, p),
      ids: [...q, ...p].map((r) => r.id),
      dateGap,
      referenceMatch: ref,
      identity,
      flags: [
        ...(referenceConflict ? ["PO reference conflict"] : []),
        ...(late ? ["Late PO"] : []),
        ...(sum(q) < 0 ? ["Refund / credit"] : []),
        ...(matchAndFlag && identity < 0
          ? ["PO technician differs from card user"]
          : []),
        ...(matchAndFlag && identity === 0
          ? ["Card user / PO technician not fully verified"]
          : []),
      ],
      reasons: [
        `Exact normalized vendor: ${normalize(q[0].vendor, rules)} (+${config.weights.vendor}).`,
        `Amount difference ${delta} cents (+${amountPoints}).`,
        `Maximum date gap ${dateGap} days (+${datePoints}).`,
        ref
          ? `Reference agrees (+${config.weights.reference}).`
          : "No shared PO reference (+0).",
        `Policy: threshold ${config.autoThreshold}, tolerance ${config.toleranceCents} cents. Engine ${ENGINE_VERSION}.`,
        ...(config.maxGroup === 1
          ? [
              "One-to-one policy: one card transaction linked to one purchase order; purchases and POs are never combined.",
            ]
          : []),
      ],
    });
  }
  const availableQ = charges.filter((r) => !consumed.has(r.id)),
    availableP = pos.filter((r) => !consumed.has(r.id));
  // Enumerate every 1:1 candidate before spending the budget on groups.
  if (config.maxGroup === 1) {
    // Richmond: a purchase and a PO are indivisible. Never search combinations
    // or let a legacy group-search limit block a valid one-to-one candidate.
    for (const q of availableQ)
      for (const p of availableP) if (compatible(q, p)) propose([q], [p]);
  } else if (matchAndFlag) {
    for (const q of availableQ)
      availableP
        .filter((p) => compatible(q, p))
        .forEach((p) => propose([q], [p]));
    for (const q of availableQ) {
      if (candidates.length >= 20000) {
        bounded.add(q.id);
        continue;
      }
      const found = balancedGroups(
        availableP.filter((p) => compatible(q, p)),
        q.amount,
        config.maxGroup,
        config.toleranceCents,
      );
      found.groups.forEach((group) => propose([q], group));
      if (found.limited) bounded.add(q.id);
    }
    for (const p of availableP) {
      if (candidates.length >= 20000) {
        bounded.add(p.id);
        continue;
      }
      const found = balancedGroups(
        availableQ.filter((q) => compatible(q, p)),
        p.amount,
        config.maxGroup,
        config.toleranceCents,
      );
      found.groups.forEach((group) => propose(group, [p]));
      if (found.limited) bounded.add(p.id);
    }
  } else {
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
  }
  const safe = (c: Candidate) =>
    !c.flags.includes("PO reference conflict") &&
    !c.q.some((q) => duplicate.has(q.id));
  candidates.sort(
    (a, b) =>
      (matchAndFlag ? Number(safe(b)) - Number(safe(a)) : 0) ||
      Number(b.exact) - Number(a.exact) ||
      (matchAndFlag
        ? Number(b.score >= config.autoThreshold) -
            Number(a.score >= config.autoThreshold) ||
          Number(b.referenceMatch) - Number(a.referenceMatch) ||
          b.identity - a.identity ||
          a.ids.length - b.ids.length
        : 0) ||
      b.score - a.score ||
      (matchAndFlag ? a.dateGap - b.dateGap : 0) ||
      a.key.localeCompare(b.key),
  );
  const ids = (c: Candidate) => c.ids;
  const byRecord = new Map<string, Candidate[]>();
  for (const c of candidates)
    for (const id of c.ids) {
      const list = byRecord.get(id) || [];
      list.push(c);
      byRecord.set(id, list);
    }
  for (const c of candidates) {
    if (ids(c).some((id) => consumed.has(id))) continue;
    const alternatives = [
      ...new Set(c.ids.flatMap((id) => byRecord.get(id) || [])),
    ].filter(
      (o) =>
        o !== c &&
        o.exact === c.exact &&
        Math.abs(o.score - c.score) <= config.ambiguityMargin &&
        (!matchAndFlag || !safe(c) || safe(o)) &&
        !ids(o).some((id) => consumed.has(id)),
    );
    const overlap = alternatives.length > 0;
    const dup = c.q.some((q) => duplicate.has(q.id));
    const truncated = ids(c).some((id) => bounded.has(id));
    const automatic =
      matchAndFlag && c.exact && safe(c) && c.score >= config.autoThreshold;
    const flags = [
      ...c.flags,
      ...(matchAndFlag && overlap ? ["Competing PO candidates"] : []),
      ...(matchAndFlag && truncated ? ["Group search limited"] : []),
    ];
    const uncertainty = flags.some((flag) => flag !== "Refund / credit");
    let status = automatic
      ? uncertainty
        ? "Matched with flags"
        : "Matched"
      : dup
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
                automatic
                  ? `${alternatives.length} competing candidate(s) within ${config.ambiguityMargin} points. Alternatives: ${alternatives
                      .slice(0, 5)
                      .map((o) => `${o.key} (${o.score}%)`)
                      .join(
                        "; ",
                      )}${alternatives.length > 5 ? "; additional candidates omitted" : ""}.`
                  : "Competing candidates overlap within the ambiguity margin; human review required.",
              ]
            : []),
          ...(dup
            ? [
                "Same vendor, account, date and amount appears on another charge.",
              ]
            : []),
          ...(truncated
            ? [
                automatic
                  ? "The bounded group search was incomplete. The selected vendor and amount match meets the threshold; the limitation is flagged for an optional check."
                  : matchAndFlag
                    ? "Group search was limited; this candidate did not qualify for automatic matching."
                    : "Group search exceeded 14 candidates; automatic matching disabled.",
              ]
            : []),
          ...(automatic
            ? [
                "Automatically reconciled under Match and flag policy. Flags are informational; individual confirmation is not required.",
                "Selection preference: shared PO reference, verified card-user/PO-technician agreement, fewer records, confidence, closest dates, then stable source IDs. These preferences do not add confidence points.",
                c.identity > 0
                  ? "The linked card-user and PO-technician identities agree."
                  : c.identity < 0
                    ? "The selected PO technician differs from the mapped card user; attribution follows the card user and is flagged."
                    : "A complete card-user/PO-technician identity comparison was unavailable.",
              ]
            : []),
        ],
        flags,
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
          : q.amount < 0
            ? "Unallocated refund"
            : days(asOf, q.date) > config.graceDays
              ? "Missing PO"
              : "Awaiting PO",
        0,
        [
          duplicate.has(q.id)
            ? "Another charge has the same vendor, account, date and amount."
            : q.amount < 0
              ? "Refund / credit identified, but no compatible credit purchase order was found. Review its allocation; the negative amount is retained."
              : "No available compatible purchase order found.",
          ...(q.amount < 0 ? [] : [`Grace period: ${config.graceDays} days.`]),
          ...(matchAndFlag && bounded.has(q.id)
            ? [
                "The bounded group search was incomplete; no qualifying match was selected.",
              ]
            : []),
        ],
        [
          ...(q.amount < 0 ? ["Unallocated refund / credit"] : []),
          ...(matchAndFlag && bounded.has(q.id)
            ? ["Group search limited"]
            : []),
        ],
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
              ...(matchAndFlag && bounded.has(p.id)
                ? [
                    "The bounded group search was incomplete; no qualifying match was selected.",
                  ]
                : []),
            ],
        matchAndFlag && bounded.has(p.id) ? ["Group search limited"] : [],
      ),
    );
  }
  return output.sort(
    (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
  );
}
