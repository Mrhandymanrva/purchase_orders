import { z } from "zod";
import { recordSchema, type RecordItem, type Directory } from "./domain";
import { pool } from "./store";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { integrationSetup, IntegrationSetupError } from "./integration-setup";
type Fetcher = typeof fetch;
const required = (key: string) => {
  const v = process.env[key];
  if (!v?.trim()) throw Error(`Integration configuration missing: ${key}`);
  return v;
};
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
export async function getJSON(
  url: string,
  headers: Record<string, string>,
  fetcher: Fetcher = fetch,
) {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    ![
      "quickbooks.api.intuit.com",
      "sandbox-quickbooks.api.intuit.com",
      "api.servicetitan.io",
      "api-integration.servicetitan.io",
    ].includes(u.hostname)
  )
    throw Error("Integration host is not allowed");
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && attempt < 3) {
      const retry = Number(r.headers.get("retry-after"));
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(10000, retry > 0 ? retry * 1000 : 250 * 2 ** attempt),
        ),
      );
      continue;
    }
    throw Error(`Integration GET failed (${u.hostname}, HTTP ${r.status})`);
  }
  throw Error("Integration retry limit");
}
const qboSchema = z.object({
  Id: sourceId,
  PaymentType: z.string(),
  TotalAmt: decimal,
  TxnDate: z.string(),
  Credit: z.boolean().optional(),
  CurrencyRef: z.object({ value: z.string() }).optional(),
  EntityRef: z
    .object({ value: z.string(), name: z.string().optional() })
    .optional(),
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
  if (!q.EntityRef?.name)
    throw Error(
      "Integration QBO vendor name missing; populate the vendor before reconciliation",
    );
  const reference =
    q.CustomField?.find((f) => /^(po|po number|purchase order)$/i.test(f.Name))
      ?.StringValue ||
    q.PrivateNote?.match(/\bPO-\d+\b/i)?.[0] ||
    "";
  const mapped = recordSchema.parse({
    id: `QBO:${q.Id}`,
    source: "qbo",
    vendor: q.EntityRef.name,
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
    ...mapped,
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
  businessUnitId: sourceId.optional(),
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
  if (/^(canceled|cancelled|pending)$/i.test(p.status)) return null;
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
    inventoryLocationId: p.inventoryLocationId || undefined,
  });
}
export async function readQBO(
  token: string,
  realm: string,
  from: string,
  to: string,
  fetcher: Fetcher = fetch,
) {
  const base =
    process.env.QBO_ENV === "production"
      ? "https://quickbooks.api.intuit.com"
      : "https://sandbox-quickbooks.api.intuit.com";
  const records: RecordItem[] = [];
  const accounts = required("QBO_CARD_ACCOUNT_IDS")
    .split(",")
    .map((s) => s.trim());
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
    | "employees",
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
      `${base}/${["technicians", "employees"].includes(kind) ? "settings" : "inventory"}/v2/tenant/${encodeURIComponent(tenant)}/${kind}?page=${page}&pageSize=200&includeTotal=true${kind === "purchase-orders" ? "" : "&active=Any"}`,
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
) {
  const vendorRows = await readSTPages("vendors", token, fetcher);
  const vendors = new Map(
    vendorRows.map((raw) => {
      const v = z.object({ id: sourceId, name: z.string().min(1) }).parse(raw);
      return [v.id, v.name];
    }),
  );
  const rows = await readSTPages("purchase-orders", token, fetcher);
  const units = required("ST_BUSINESS_UNIT_IDS")
    .split(",")
    .map((s) => s.trim());
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
function key() {
  const value = Buffer.from(required("TOKEN_ENCRYPTION_KEY"), "base64");
  if (value.length !== 32)
    throw Error(
      "Integration TOKEN_ENCRYPTION_KEY must contain 32 base64-encoded bytes",
    );
  return value;
}
export function encryptToken(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64",
  );
}
export function decryptToken(value: string) {
  const bytes = Buffer.from(value, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    decipher.update(bytes.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}
async function quickBooksToken(fetcher: Fetcher) {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(749222)");
    const stored = await client.query(
      "SELECT payload FROM oauth_tokens WHERE provider='qbo'",
    );
    if (stored.rows[0]?.payload) {
      const v = JSON.parse(decryptToken(stored.rows[0].payload));
      if (v.expiresAt > Date.now() + 120000) {
        await client.query("COMMIT");
        return v.accessToken;
      }
    }
    const refreshToken = stored.rows[0]?.payload
      ? JSON.parse(decryptToken(stored.rows[0].payload)).refreshToken
      : required("QBO_REFRESH_TOKEN");
    const r = await fetcher(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              required("QBO_CLIENT_ID") + ":" + required("QBO_CLIENT_SECRET"),
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!r.ok)
      throw Error(
        `Integration QBO authentication failed (${r.status}); reconnect if refresh token expired`,
      );
    const v = z
      .object({
        access_token: z.string(),
        refresh_token: z.string(),
        expires_in: z.number(),
      })
      .parse(await r.json());
    await client.query(
      "INSERT INTO oauth_tokens(provider,payload) VALUES('qbo',$1) ON CONFLICT(provider) DO UPDATE SET payload=EXCLUDED.payload",
      [
        encryptToken(
          JSON.stringify({
            accessToken: v.access_token,
            refreshToken: v.refresh_token,
            expiresAt: Date.now() + v.expires_in * 1000,
          }),
        ),
      ],
    );
    await client.query("COMMIT");
    return v.access_token;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export async function fetchSnapshot(fetcher: Fetcher = fetch) {
  await requireIntegrationSetup("sync");
  const from = required("SYNC_FROM");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(from)))
    throw Error("Integration SYNC_FROM must be YYYY-MM-DD");
  const to = new Date().toISOString().slice(0, 10);
  if (from > to) throw Error("Integration SYNC_FROM is in the future");
  const stFrom = new Date(Date.parse(from) - 90 * 86400000)
    .toISOString()
    .slice(0, 10);
  const stToken = await serviceTitanToken(fetcher),
    qboToken = await quickBooksToken(fetcher);
  const [pos, charges, directory] = await Promise.all([
    readST(stToken, stFrom, to, fetcher),
    readQBO(qboToken, required("QBO_REALM_ID"), from, to, fetcher),
    readDirectories(stToken, qboToken, required("QBO_REALM_ID"), fetcher),
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
): Promise<Directory["accounts"]> {
  const base =
    process.env.QBO_ENV === "production"
      ? "https://quickbooks.api.intuit.com"
      : "https://sandbox-quickbooks.api.intuit.com";
  const schema = z.object({
    Id: sourceId,
    Name: z.string(),
    FullyQualifiedName: z.string().optional(),
    AccountType: z.string(),
    SubAccount: z.boolean().optional(),
    Active: z.boolean(),
    ParentRef: z.object({ value: sourceId }).optional(),
  });
  const accounts: z.infer<typeof schema>[] = [];
  for (let start = 1; start <= 10001; start += 1000) {
    const query = `SELECT * FROM Account WHERE Active IN (true, false) STARTPOSITION ${start} MAXRESULTS 1000`;
    const raw = await getJSON(
      `${base}/v3/company/${encodeURIComponent(realm)}/query?query=${encodeURIComponent(query)}&minorversion=75`,
      { Authorization: `Bearer ${token}` },
      fetcher,
    );
    const rows =
      z
        .object({
          QueryResponse: z.object({ Account: z.array(schema).optional() }),
        })
        .parse(raw).QueryResponse.Account || [];
    accounts.push(...rows);
    if (rows.length < 1000) {
      const parent = process.env.QBO_PARENT_CC_ACCOUNT_ID,
        allow = new Set(
          (
            process.env.QBO_CARD_ACCOUNT_IDS ||
            (parent ? "" : required("QBO_CARD_ACCOUNT_IDS"))
          )
            .split(",")
            .map((v) => v.trim()),
        );
      const belowParent = (a: z.infer<typeof schema>) => {
        let id = a.ParentRef?.value;
        const seen = new Set<string>();
        while (id && !seen.has(id)) {
          if (id === parent) return true;
          seen.add(id);
          id = accounts.find((v) => v.Id === id)?.ParentRef?.value;
        }
        return false;
      };
      const result = accounts
        .filter(
          (a) =>
            a.AccountType === "Credit Card" &&
            a.SubAccount &&
            a.Id !== parent &&
            (parent ? belowParent(a) : allow.has(a.Id)),
        )
        .map((a) => ({
          id: a.Id,
          name: a.FullyQualifiedName || a.Name,
          active: a.Active,
          parentId: a.ParentRef?.value,
        }));
      if (new Set(result.map((a) => a.id)).size !== result.length)
        throw Error("Integration duplicate QuickBooks account IDs");
      return result;
    }
  }
  throw Error("Integration QuickBooks account directory pagination limit");
}
export async function readDirectories(
  stToken: string,
  qboToken: string,
  realm: string,
  fetcher: Fetcher = fetch,
): Promise<Directory> {
  const [techs, employees, types, accounts] = await Promise.all([
    readSTPages("technicians", stToken, fetcher),
    readSTPages("employees", stToken, fetcher),
    readSTPages("purchase-order-types", stToken, fetcher),
    readQBAccounts(qboToken, realm, fetcher),
  ]);
  const schema = z.object({
    id: sourceId,
    name: z.string().min(1),
    active: z.boolean(),
  });
  const people = [
    ...techs.map((r) => ({ ...schema.parse(r), kind: "technician" as const })),
    ...employees.map((r) => ({
      ...schema.parse(r),
      kind: "employee" as const,
    })),
  ].map((p) => ({ ...p, sourceId: p.id, id: `${p.kind}:${p.id}` }));
  const poTypes = types.map((r) => schema.parse(r));
  if (
    new Set(people.map((p) => p.id)).size !== people.length ||
    new Set(poTypes.map((p) => p.id)).size !== poTypes.length
  )
    throw Error("Integration duplicate ServiceTitan directory IDs");
  return { people, accounts, poTypes, syncedAt: new Date().toISOString() };
}
export async function fetchDirectories(fetcher: Fetcher = fetch) {
  await requireIntegrationSetup("directory");
  const [st, qbo] = await Promise.all([
    serviceTitanToken(fetcher),
    quickBooksToken(fetcher),
  ]);
  return readDirectories(st, qbo, required("QBO_REALM_ID"), fetcher);
}

export async function readIntegrationSetup() {
  let storedToken = false;
  if (!process.env.QBO_REFRESH_TOKEN?.trim() && process.env.DATABASE_URL) {
    const result = await pool().query(
      "SELECT EXISTS (SELECT 1 FROM oauth_tokens WHERE provider='qbo' AND payload IS NOT NULL) AS present",
    );
    storedToken = result.rows[0]?.present === true;
  }
  return integrationSetup(process.env, storedToken);
}

async function requireIntegrationSetup(operation: "sync" | "directory") {
  const setup = await readIntegrationSetup();
  if (!(operation === "sync" ? setup.syncReady : setup.directoryReady)) {
    throw new IntegrationSetupError(setup, operation);
  }
}
