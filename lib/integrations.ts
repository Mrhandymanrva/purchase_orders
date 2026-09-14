import { z } from "zod";
import {
  recordSchema,
  type RecordItem,
  type Directory,
  type State,
} from "./domain";
import { pool, readState } from "./store";
import {
  qboSession,
  configuredQBO,
  readCreditCardAccounts,
  cardDescendants,
  QuickBooksError,
} from "./quickbooks";
import { required, getJSON } from "./integration-transport";
export { getJSON } from "./integration-transport";
export { encryptToken, decryptToken } from "./token-crypto";
import { integrationSetup, IntegrationSetupError } from "./integration-setup";
import { configuredST, ServiceTitanSetupError } from "./servicetitan-settings";
import { resolveVendorDescription } from "./vendor-evidence";
type Fetcher = typeof fetch;
const sourceId = z
  .union([z.string().min(1), z.number().int().safe()])
  .transform(String);
const decimal = z.union([z.string(), z.number()]);
export function cents(value: string | number): number {
  const s = String(value);
  if (!/^-?\d+(\.\d{1,2})?$/.test(s))
    throw Error("Integration amount must have at most two decimals");
  const [whole, fraction = ""] = s.replace("-", "").split(".");
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(n)) throw Error("Integration amount out of range");
  return s.startsWith("-") ? -n : n;
}
const qboSchema = z.object({
  Id: sourceId,
  PaymentType: z.string(),
  TotalAmt: decimal,
  TxnDate: z.string(),
  Credit: z.boolean().optional(),
  CurrencyRef: z.object({ value: z.string() }).optional(),
  EntityRef: z
    .object({ value: z.string(), name: z.string().nullish() })
    .nullish(),
  AccountRef: z.object({ value: z.string(), name: z.string().optional() }),
  PrivateNote: z.string().optional(),
  CustomField: z
    .array(z.object({ Name: z.string(), StringValue: z.string().optional() }))
    .optional(),
  MetaData: z.object({ CreateTime: z.string().optional() }).optional(),
});
export function mapQBO(raw: unknown): RecordItem | null {
  const q = qboSchema.parse(raw);
  if (q.PaymentType !== "CreditCard") return null;
  if (q.CurrencyRef && q.CurrencyRef.value !== "USD")
    throw Error("Integration unsupported currency; USD workspace required");
  if (cents(q.TotalAmt) < 0)
    throw Error(
      "Integration negative QBO TotalAmt is unsupported; use Credit flag for refunds",
    );
  const amount = Math.abs(cents(q.TotalAmt)) * (q.Credit ? -1 : 1);
  const vendor = q.EntityRef?.name?.trim();
  const reference =
    q.CustomField?.find((f) => /^(po|po number|purchase order)$/i.test(f.Name))
      ?.StringValue ||
    q.PrivateNote?.match(/\bPO-\d+\b/i)?.[0] ||
    "";
  const mapped = recordSchema.parse({
    id: `QBO:${q.Id}`,
    source: "qbo",
    vendor: vendor || "Vendor not specified in QuickBooks",
    ...(!vendor ? { vendorMissing: true } : {}),
    amount,
    date: q.TxnDate,
    reference,
    currency: "USD",
    description: q.PrivateNote || "",
    account: q.AccountRef.name || q.AccountRef.value,
    accountId: q.AccountRef.value,
    createdAt: q.MetaData?.CreateTime,
  });
  const accountUsers = z
    .record(z.string().min(2))
    .parse(JSON.parse(process.env.QBO_CARDHOLDERS_JSON || "{}"));
  const field = process.env.QBO_CARDHOLDER_FIELD;
  const explicit = field
    ? q.CustomField?.find((f) => f.Name === field)?.StringValue
    : undefined;
  return {
    ...resolveVendorDescription(mapped),
    cardUser: explicit || accountUsers[q.AccountRef.value] || "Unassigned",
    ownershipSource: explicit
      ? "QuickBooks custom field"
      : accountUsers[q.AccountRef.value]
        ? "Verified card account mapping"
        : "Unassigned",
  };
}
const stSchema = z.object({
  id: sourceId,
  vendorId: sourceId,
  number: z.string(),
  date: z.string(),
  createdOn: z.string(),
  total: decimal,
  status: z.string(),
  businessUnitId: sourceId.nullish(),
  summary: z.string().nullish(),
  technicianId: sourceId.nullish(),
  typeId: sourceId.nullish(),
  inventoryLocationId: sourceId.nullish(),
});
export function mapST(
  raw: unknown,
  vendors: Map<string, string>,
): RecordItem | null {
  const p = stSchema.parse(raw);
  if (/^(canceled|cancelled)$/i.test(p.status.trim())) return null;
  const vendor = vendors.get(p.vendorId);
  if (!vendor)
    throw Error("Integration ServiceTitan vendor missing from directory");
  return recordSchema.parse({
    id: `ST:${p.id}`,
    source: "st",
    vendor,
    amount: cents(p.total),
    date: p.date.slice(0, 10),
    reference: p.number,
    currency: "USD",
    description: p.summary || "",
    account: p.businessUnitId || "",
    createdAt: p.createdOn,
    technicianId: p.technicianId || undefined,
    poTypeId: p.typeId || undefined,
    poStatus: p.status,
    inventoryLocationId: p.inventoryLocationId || undefined,
  });
}
export async function readQBO(
  token: string,
  realm: string,
  from: string,
  to: string,
  fetcher: Fetcher = fetch,
  selectedAccounts?: string[],
) {
  const base =
    process.env.QBO_ENV === "production"
      ? "https://quickbooks.api.intuit.com"
      : "https://sandbox-quickbooks.api.intuit.com";
  const records: RecordItem[] = [];
  const accounts =
    selectedAccounts ??
    required("QBO_CARD_ACCOUNT_IDS")
      .split(",")
      .map((s) => s.trim());
  if (!accounts.length)
    throw new QuickBooksError(
      "Choose the child cards to import in Integrations.",
    );
  for (let start = 1; start <= 10001; start += 1000) {
    const query = `SELECT * FROM Purchase WHERE TxnDate >= '${from}' AND TxnDate <= '${to}' STARTPOSITION ${start} MAXRESULTS 1000`;
    const response = await getJSON(
      `${base}/v3/company/${encodeURIComponent(realm)}/query?query=${encodeURIComponent(query)}&minorversion=75`,
      { Authorization: `Bearer ${token}` },
      fetcher,
    );
    const parsed = z
      .object({
        QueryResponse: z.object({ Purchase: z.array(z.unknown()).optional() }),
      })
      .parse(response);
    const rows = parsed.QueryResponse.Purchase || [];
    for (const row of rows) {
      const q = qboSchema.parse(row);
      if (
        q.PaymentType !== "CreditCard" ||
        !accounts.includes(q.AccountRef.value)
      )
        continue;
      const record = mapQBO(row);
      if (record) records.push(record);
    }
    if (rows.length < 1000) return records;
  }
  throw Error("Integration QBO pagination limit reached; narrow SYNC_FROM");
}
async function readSTPages(
  kind:
    | "vendors"
    | "purchase-orders"
    | "purchase-order-types"
    | "technicians"
    | "employees"
    | "business-units",
  token: string,
  fetcher: Fetcher,
) {
  const base =
    process.env.ST_ENV === "production"
      ? "https://api.servicetitan.io"
      : "https://api-integration.servicetitan.io";
  const tenant = required("ST_TENANT_ID");
  const records: unknown[] = [];
  for (let page = 1; page <= 100; page++) {
    const data = await getJSON(
      `${base}/${["technicians", "employees", "business-units"].includes(kind) ? "settings" : "inventory"}/v2/tenant/${encodeURIComponent(tenant)}/${kind}?page=${page}&pageSize=200&includeTotal=true${kind === "purchase-orders" ? "" : ["technicians", "employees"].includes(kind) ? "&active=True" : "&active=Any"}`,
      {
        Authorization: `Bearer ${token}`,
        "ST-App-Key": required("ST_APP_KEY"),
      },
      fetcher,
    );
    const parsed = z
      .object({ data: z.array(z.unknown()), hasMore: z.boolean() })
      .parse(data);
    records.push(...parsed.data);
    if (!parsed.hasMore) return records;
  }
  throw Error("Integration ServiceTitan pagination limit reached");
}
export async function readST(
  token: string,
  from: string,
  to: string,
  fetcher: Fetcher = fetch,
  selectedUnits?: string[],
) {
  const units = selectedUnits ?? configuredST().businessUnitIds;
  if (!units.length)
    throw new ServiceTitanSetupError(
      "Choose the ServiceTitan business units to import in Integrations.",
    );
  const vendorRows = await readSTPages("vendors", token, fetcher);
  const vendors = new Map(
    vendorRows.map((raw) => {
      const v = z.object({ id: sourceId, name: z.string().min(1) }).parse(raw);
      return [v.id, v.name];
    }),
  );
  const rows = await readSTPages("purchase-orders", token, fetcher);
  return rows.flatMap((raw) => {
    const p = stSchema.parse(raw);
    if (
      !p.businessUnitId ||
      !units.includes(p.businessUnitId) ||
      p.date.slice(0, 10) < from ||
      p.date.slice(0, 10) > to
    )
      return [];
    const mapped = mapST(raw, vendors);
    return mapped ? [mapped] : [];
  });
}
async function serviceTitanToken(fetcher: Fetcher) {
  const host =
    process.env.ST_ENV === "production"
      ? "https://auth.servicetitan.io"
      : "https://auth-integration.servicetitan.io";
  const r = await fetcher(host + "/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: required("ST_CLIENT_ID"),
      client_secret: required("ST_CLIENT_SECRET"),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok)
    throw Error(`Integration ServiceTitan authentication failed (${r.status})`);
  return z.object({ access_token: z.string() }).parse(await r.json())
    .access_token;
}
export async function fetchSnapshot(fetcher: Fetcher = fetch) {
  await requireIntegrationSetup("sync");
  const stScope = configuredST(
    process.env.DATABASE_URL ? await readState() : undefined,
  );
  const from = required("SYNC_FROM");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(from)))
    throw Error("Integration SYNC_FROM must be YYYY-MM-DD");
  const to = new Date().toISOString().slice(0, 10);
  if (from > to) throw Error("Integration SYNC_FROM is in the future");
  const stFrom = new Date(Date.parse(from) - 90 * 86400000)
    .toISOString()
    .slice(0, 10);
  const stToken = await serviceTitanToken(fetcher),
    qbo = await qboSession(fetcher);
  const [pos, charges, directory] = await Promise.all([
    readST(stToken, stFrom, to, fetcher, stScope.businessUnitIds),
    readQBO(qbo.accessToken, qbo.realm, from, to, fetcher, qbo.accountIds),
    readDirectories(stToken, qbo.accessToken, qbo.realm, fetcher, qbo),
  ]);
  const records = [...charges, ...pos];
  if (records.length > 2000)
    throw Error(
      "Integration snapshot exceeds the Richmond MVP limit of 2000 records",
    );
  if (new Set(records.map((r) => r.id)).size !== records.length)
    throw Error("Integration duplicate source IDs across pages");
  return {
    records,
    directory,
    coverage: { chargesFrom: from, posFrom: stFrom, through: to },
  };
}

export async function readQBAccounts(
  token: string,
  realm: string,
  fetcher: Fetcher = fetch,
  scope?: { parentAccountId: string; accountIds: string[] },
): Promise<Directory["accounts"]> {
  const accounts = await readCreditCardAccounts(token, realm, fetcher);
  const parent = scope?.parentAccountId ?? process.env.QBO_PARENT_CC_ACCOUNT_ID;
  const ids =
    scope?.accountIds ??
    (process.env.QBO_CARD_ACCOUNT_IDS || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  if (!parent && !ids.length)
    throw new QuickBooksError(
      "Choose your parent credit-card account and the cards to import in Integrations.",
    );
  return (
    parent
      ? cardDescendants(accounts, parent)
      : accounts.filter((a) => a.subAccount && ids.includes(a.id))
  ).map(({ subAccount, ...a }) => a);
}
export class IntegrationDirectoryError extends Error {
  name = "IntegrationDirectoryError";
}
export function mapSTPeople(rows: unknown[], kind: "technician" | "employee") {
  const schema = z.object({
    id: sourceId,
    name: z.unknown().optional(),
    active: z.boolean(),
  });
  const people: Directory["people"] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const person = schema.parse(row);
    if (seen.has(person.id))
      throw new IntegrationDirectoryError(
        `ServiceTitan returned duplicate ${kind} IDs. The previous dropdowns were kept; retry the refresh.`,
      );
    seen.add(person.id);
    if (!person.active) continue;
    const parsedName = z.string().trim().min(1).safeParse(person.name);
    if (!parsedName.success)
      throw new IntegrationDirectoryError(
        `Active ServiceTitan ${kind} #${person.id} has no usable name. Add its name in ServiceTitan, then refresh the dropdowns.`,
      );
    const name = parsedName.data;
    people.push({
      id: `${kind}:${person.id}`,
      sourceId: person.id,
      name,
      active: person.active,
      kind,
    });
  }
  return people;
}
export async function readDirectories(
  stToken: string,
  qboToken: string,
  realm: string,
  fetcher: Fetcher = fetch,
  scope?: { parentAccountId: string; accountIds: string[] },
): Promise<Directory> {
  const [techs, employees, types, accounts] = await Promise.all([
    readSTPages("technicians", stToken, fetcher),
    readSTPages("employees", stToken, fetcher),
    readSTPages("purchase-order-types", stToken, fetcher),
    readQBAccounts(qboToken, realm, fetcher, scope),
  ]);
  const schema = z.object({
    id: sourceId,
    name: z.string().min(1),
    active: z.boolean(),
  });
  const technicians = mapSTPeople(techs, "technician");
  const staff = mapSTPeople(employees, "employee");
  const people = [...technicians, ...staff];
  const poTypes = types.map((r) => schema.parse(r));
  if (
    new Set(people.map((p) => p.id)).size !== people.length ||
    new Set(poTypes.map((p) => p.id)).size !== poTypes.length
  )
    throw Error("Integration duplicate ServiceTitan directory IDs");
  return {
    people,
    accounts,
    poTypes,
    syncedAt: new Date().toISOString(),
  };
}
export async function fetchDirectories(fetcher: Fetcher = fetch) {
  await requireIntegrationSetup("directory");
  const [st, qbo] = await Promise.all([
    serviceTitanToken(fetcher),
    qboSession(fetcher),
  ]);
  return readDirectories(st, qbo.accessToken, qbo.realm, fetcher, qbo);
}

export async function fetchSTBusinessUnits(
  fetcher: Fetcher = fetch,
): Promise<NonNullable<State["serviceTitan"]>> {
  const { tenantId, environment } = configuredST();
  required("ST_TENANT_ID");
  required("ST_APP_KEY");
  const token = await serviceTitanToken(fetcher);
  const rows = await readSTPages("business-units", token, fetcher);
  const schema = z.object({
    id: sourceId,
    name: z.string().trim().min(1),
    active: z.boolean(),
  });
  const businessUnits = rows.map((row) => schema.parse(row));
  if (
    new Set(businessUnits.map((unit) => unit.id)).size !== businessUnits.length
  )
    throw new ServiceTitanSetupError(
      "ServiceTitan returned duplicate business unit IDs. Retry loading business units.",
    );
  return {
    tenantId,
    environment,
    businessUnits,
    discoveredAt: new Date().toISOString(),
  };
}

export async function readIntegrationSetup() {
  let storedToken = false;
  if (!process.env.QBO_REFRESH_TOKEN?.trim() && process.env.DATABASE_URL) {
    const result = await pool().query(
      "SELECT EXISTS (SELECT 1 FROM oauth_tokens WHERE provider='qbo' AND payload IS NOT NULL) AS present",
    );
    storedToken = result.rows[0]?.present === true;
  }
  const state = process.env.DATABASE_URL ? await readState() : undefined;
  const config = state?.quickbooks ? configuredQBO(state) : undefined;
  const st = state?.serviceTitan ? configuredST(state) : undefined;
  return integrationSetup(
    {
      ...process.env,
      ...(config
        ? {
            QBO_REALM_ID: config.realm,
            QBO_PARENT_CC_ACCOUNT_ID: config.parentAccountId,
            QBO_CARD_ACCOUNT_IDS: config.accountIds.join(","),
          }
        : {}),
      ...(st ? { ST_BUSINESS_UNIT_IDS: st.businessUnitIds.join(",") } : {}),
    },
    storedToken,
  );
}

async function requireIntegrationSetup(operation: "sync" | "directory") {
  const setup = await readIntegrationSetup();
  if (!(operation === "sync" ? setup.syncReady : setup.directoryReady)) {
    throw new IntegrationSetupError(setup, operation);
  }
}
