import { cardDescendants } from "./quickbooks-accounts";
export { cardDescendants } from "./quickbooks-accounts";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  pool,
  readState,
  readDB,
  persistDB,
  appendAudit,
  Conflict,
  type DB,
} from "./store";
import type { State, QuickBooksAccount, QuickBooksSettings } from "./domain";
import { getJSON, required } from "./integration-transport";
import { encryptToken, decryptToken } from "./token-crypto";

export const QBO_CALLBACK = "/api/integrations/quickbooks/callback";
export const QBO_COOKIE = "__Host-richmond-qbo";
const tokenEndpoint =
  "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class QuickBooksError extends Error {}
export function qboEnvironment(): "production" | "sandbox" {
  const env = process.env.QBO_ENV || "sandbox";
  if (env !== "production" && env !== "sandbox")
    throw new QuickBooksError(
      "Choose a valid QuickBooks environment in Railway.",
    );
  return env;
}
export const qboClientFingerprint = () => digest(required("QBO_CLIENT_ID"));
export function qboRedirectUri() {
  const origin = new URL(required("APP_ORIGIN"));
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new QuickBooksError(
      "QuickBooks connection requires an HTTPS APP_ORIGIN without a path.",
    );
  return origin.origin + QBO_CALLBACK;
}
export function configuredQBO(state: State) {
  const saved = state.quickbooks;
  if (
    saved &&
    (saved.environment !== qboEnvironment() ||
      saved.clientFingerprint !== qboClientFingerprint())
  )
    throw new QuickBooksError(
      "QuickBooks app settings changed. Restore the original environment and client ID for this workspace.",
    );
  return {
    realm: saved?.realm || process.env.QBO_REALM_ID || "",
    parentAccountId: saved
      ? saved.parentAccountId || ""
      : process.env.QBO_PARENT_CC_ACCOUNT_ID || "",
    accountIds: saved
      ? saved.accountIds
      : (process.env.QBO_CARD_ACCOUNT_IDS || "")
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
  };
}
export async function startQBOAuthorization(actor: string, db: DB = pool()) {
  const redirect = qboRedirectUri();
  required("QBO_CLIENT_SECRET");
  encryptToken("key-check");
  const environment = qboEnvironment(),
    fingerprint = qboClientFingerprint();
  const state = randomBytes(32).toString("base64url"),
    browser = randomBytes(32).toString("base64url");
  await db.query("DELETE FROM oauth_states WHERE expires_at <= now()");
  await db.query(
    "INSERT INTO oauth_states(state_hash,browser_hash,actor,environment,client_fingerprint,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
    [digest(state), digest(browser), actor, environment, fingerprint],
  );
  const url = new URL("https://appcenter.intuit.com/connect/oauth2");
  url.search = new URLSearchParams({
    client_id: required("QBO_CLIENT_ID"),
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: redirect,
    state,
  }).toString();
  return { url: url.toString(), browser };
}
export async function consumeQBOState(
  state: string,
  browser: string,
  db: DB = pool(),
) {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(state) ||
    !/^[A-Za-z0-9_-]{43}$/.test(browser)
  )
    throw new QuickBooksError(
      "The QuickBooks connection attempt is invalid or expired. Start again from Integrations.",
    );
  const result = await db.query(
    "DELETE FROM oauth_states WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() AND environment=$3 AND client_fingerprint=$4 RETURNING actor",
    [digest(state), digest(browser), qboEnvironment(), qboClientFingerprint()],
  );
  if (result.rows.length !== 1)
    throw new QuickBooksError(
      "The QuickBooks connection attempt is invalid or expired. Start again from Integrations.",
    );
  return String(result.rows[0].actor);
}
const tokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive().max(86400),
});
async function exchangeQBOTokens(
  params: URLSearchParams,
  fetcher: typeof fetch,
) {
  const response = await fetcher(tokenEndpoint, {
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
    body: params,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new QuickBooksError(
      `QuickBooks authorization was not accepted (HTTP ${response.status}). Check the production app credentials and try Connect QuickBooks again.`,
    );
  const result = tokensSchema.safeParse(await response.json());
  if (!result.success)
    throw new QuickBooksError(
      "QuickBooks returned an incomplete authorization. Try connecting again.",
    );
  return {
    accessToken: result.data.access_token,
    refreshToken: result.data.refresh_token,
    expiresAt: Date.now() + result.data.expires_in * 1000,
  };
}
export async function exchangeQBOCode(
  code: string,
  fetcher: typeof fetch = fetch,
) {
  if (!code || code.length > 4000)
    throw new QuickBooksError(
      "QuickBooks did not return a valid authorization code.",
    );
  return exchangeQBOTokens(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: qboRedirectUri(),
    }),
    fetcher,
  );
}
export async function withQBOTransaction<T>(fn: (db: DB) => Promise<T>) {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(749222)");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export async function persistQBOConnection(
  db: DB,
  realm: string,
  companyName: string,
  tokens: Awaited<ReturnType<typeof exchangeQBOCode>>,
  actor: string,
) {
  const state = await readDB(db, true);
  const prior = state.quickbooks;
  const expectedRealm = prior?.realm || process.env.QBO_REALM_ID;
  if (
    (expectedRealm && expectedRealm !== realm) ||
    (prior && prior.environment !== qboEnvironment())
  )
    throw new QuickBooksError(
      "This workspace belongs to a different QuickBooks company. Reconnect its original company.",
    );
  if (!expectedRealm && state.records.some((r) => r.source === "qbo"))
    throw new QuickBooksError(
      "Existing QuickBooks financial records must be verified before linking a company. Set the existing company ID in Railway first.",
    );
  const count = state.audit.length;
  const metadata: QuickBooksSettings = {
    realm,
    companyName,
    environment: qboEnvironment(),
    clientFingerprint: qboClientFingerprint(),
    connectedAt: new Date().toISOString(),
    accounts: prior?.accounts || [],
    accountIds:
      prior?.accountIds ||
      (process.env.QBO_CARD_ACCOUNT_IDS || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    parentAccountId:
      prior?.parentAccountId ||
      process.env.QBO_PARENT_CC_ACCOUNT_ID ||
      undefined,
    ...(prior?.discoveredAt ? { discoveredAt: prior.discoveredAt } : {}),
  };
  state.quickbooks = metadata;
  await db.query(
    "INSERT INTO oauth_tokens(provider,payload) VALUES('qbo',$1) ON CONFLICT(provider) DO UPDATE SET payload=EXCLUDED.payload",
    [
      encryptToken(
        JSON.stringify({
          ...tokens,
          realm,
          environment: metadata.environment,
          clientFingerprint: metadata.clientFingerprint,
        }),
      ),
    ],
  );
  appendAudit(
    state,
    actor,
    prior ? "QuickBooks reconnected" : "QuickBooks connected",
    { realm, companyName, environment: metadata.environment },
  );
  state.revision++;
  await persistDB(db, state, count);
}
export async function completeQBOConnection(
  realm: string,
  code: string,
  actor: string,
  fetcher: typeof fetch = fetch,
) {
  if (!/^\d{1,30}$/.test(realm))
    throw new QuickBooksError("QuickBooks did not return a valid company ID.");
  return withQBOTransaction(async (db) => {
    // Reject another company before spending a one-use authorization code.
    const state = await readDB(db, true);
    const expectedRealm = state.quickbooks?.realm || process.env.QBO_REALM_ID;
    if (
      (expectedRealm && expectedRealm !== realm) ||
      (state.quickbooks && state.quickbooks.environment !== qboEnvironment())
    )
      throw new QuickBooksError(
        "This workspace belongs to a different QuickBooks company. Reconnect its original company.",
      );
    const tokens = await exchangeQBOCode(code, fetcher);
    const raw = await getJSON(
      `${qboBase()}/v3/company/${realm}/companyinfo/${realm}?minorversion=75`,
      { Authorization: `Bearer ${tokens.accessToken}` },
      fetcher,
    );
    const parsed = z
      .object({ CompanyInfo: z.object({ CompanyName: z.string().min(1) }) })
      .safeParse(raw);
    if (!parsed.success)
      throw new QuickBooksError(
        "Could not verify the authorized QuickBooks company.",
      );
    await persistQBOConnection(
      db,
      realm,
      parsed.data.CompanyInfo.CompanyName,
      tokens,
      actor,
    );
  });
}
export function qboBase() {
  return qboEnvironment() === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}
export async function qboSession(fetcher: typeof fetch = fetch) {
  return withQBOTransaction(async (db) => {
    const state = await readDB(db);
    const config = configuredQBO(state);
    if (!config.realm)
      throw new QuickBooksError(
        "Choose Connect QuickBooks to authorize your company.",
      );
    const result = await db.query(
      "SELECT payload FROM oauth_tokens WHERE provider='qbo'",
    );
    const saved = result.rows[0]?.payload
      ? JSON.parse(decryptToken(result.rows[0].payload))
      : undefined;
    if (
      saved &&
      ((saved.realm && saved.realm !== config.realm) ||
        (saved.environment && saved.environment !== qboEnvironment()) ||
        (saved.clientFingerprint &&
          saved.clientFingerprint !== qboClientFingerprint()))
    )
      throw new QuickBooksError(
        "The saved QuickBooks authorization belongs to different app settings. Restore the original settings or reconnect.",
      );
    if (saved?.expiresAt > Date.now() + 120000 && saved.accessToken)
      return { ...config, accessToken: String(saved.accessToken) };
    const refreshToken = saved?.refreshToken || process.env.QBO_REFRESH_TOKEN;
    if (!refreshToken)
      throw new QuickBooksError(
        "Choose Connect QuickBooks to authorize your company.",
      );
    const tokens = await exchangeQBOTokens(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      fetcher,
    );
    await db.query(
      "INSERT INTO oauth_tokens(provider,payload) VALUES('qbo',$1) ON CONFLICT(provider) DO UPDATE SET payload=EXCLUDED.payload",
      [
        encryptToken(
          JSON.stringify({
            ...tokens,
            realm: config.realm,
            environment: qboEnvironment(),
            clientFingerprint: qboClientFingerprint(),
          }),
        ),
      ],
    );
    return { ...config, accessToken: tokens.accessToken };
  });
}
export async function readCreditCardAccounts(
  token: string,
  realm: string,
  fetcher: typeof fetch = fetch,
): Promise<QuickBooksAccount[]> {
  const accounts: QuickBooksAccount[] = [];
  const rowSchema = z.object({
    Id: z.string().min(1),
    Name: z.string(),
    FullyQualifiedName: z.string().optional(),
    AccountType: z.string(),
    SubAccount: z.boolean().optional(),
    Active: z.boolean(),
    ParentRef: z
      .object({ value: z.union([z.string(), z.number()]).transform(String) })
      .optional(),
  });
  for (let start = 1; start <= 10001; start += 1000) {
    const query = `SELECT * FROM Account WHERE Active IN (true, false) STARTPOSITION ${start} MAXRESULTS 1000`;
    const raw = await getJSON(
      `${qboBase()}/v3/company/${encodeURIComponent(realm)}/query?query=${encodeURIComponent(query)}&minorversion=75`,
      { Authorization: `Bearer ${token}` },
      fetcher,
    );
    const rows =
      z
        .object({
          QueryResponse: z.object({ Account: z.array(rowSchema).optional() }),
        })
        .parse(raw).QueryResponse.Account || [];
    accounts.push(
      ...rows
        .filter((a) => a.AccountType === "Credit Card")
        .map((a) => ({
          id: a.Id,
          name: a.FullyQualifiedName || a.Name,
          active: a.Active,
          parentId: a.ParentRef?.value,
          subAccount: Boolean(a.SubAccount),
        })),
    );
    if (rows.length < 1000) {
      if (new Set(accounts.map((a) => a.id)).size !== accounts.length)
        throw new QuickBooksError(
          "QuickBooks returned duplicate card account IDs.",
        );
      return accounts;
    }
  }
  throw new QuickBooksError(
    "QuickBooks account list exceeded the supported page limit.",
  );
}
export async function discoverQBOAccounts(
  revision: number,
  actor: string,
  fetcher: typeof fetch = fetch,
) {
  const session = await qboSession(fetcher);
  const accounts = await readCreditCardAccounts(
    session.accessToken,
    session.realm,
    fetcher,
  );
  return withQBOTransaction(async (db) => {
    const state = await readDB(db, true);
    if (state.revision !== revision)
      throw new Conflict("Workspace changed. Refresh the page and retry.");
    if (!state.quickbooks || state.quickbooks.realm !== session.realm)
      throw new QuickBooksError(
        "Use Connect QuickBooks before choosing card accounts.",
      );
    const count = state.audit.length;
    state.quickbooks.accounts = accounts;
    state.quickbooks.discoveredAt = new Date().toISOString();
    appendAudit(state, actor, "QuickBooks card accounts discovered", {
      realm: session.realm,
      count: accounts.length,
    });
    state.revision++;
    await persistDB(db, state, count);
    return state;
  });
}
export const qboSelectionSchema = z.object({
  revision: z.number().int().nonnegative(),
  parentAccountId: z.string().min(1).max(100),
  accountIds: z.array(z.string().min(1).max(100)).min(1).max(500),
  reason: z.string().trim().min(5).max(500),
});
export function applyQBOSelection(
  state: State,
  input: z.infer<typeof qboSelectionSchema>,
  actor: string,
) {
  if (state.revision !== input.revision)
    throw new Conflict("Workspace changed. Refresh the page and retry.");
  const qbo = state.quickbooks;
  if (!qbo?.discoveredAt)
    throw new QuickBooksError(
      "Load QuickBooks card accounts before saving a selection.",
    );
  const parent = qbo.accounts.find((a) => a.id === input.parentAccountId);
  if (!parent?.active)
    throw new QuickBooksError(
      "Choose an active parent card account from QuickBooks.",
    );
  const allowed = new Set(
    cardDescendants(qbo.accounts, parent.id)
      .filter((a) => a.active)
      .map((a) => a.id),
  );
  const ids = [...new Set(input.accountIds)].sort();
  if (!ids.length || ids.some((id) => !allowed.has(id)))
    throw new QuickBooksError(
      "Select active child cards under the chosen parent account.",
    );
  if (
    state.cardMappings?.some((m) => m.accountId === parent.id) ||
    state.records.some((r) => r.source === "qbo" && r.accountId === parent.id)
  )
    throw new QuickBooksError(
      "The selected parent already has card records or assignments. Review that history before changing the parent.",
    );
  const before = {
    parentAccountId: qbo.parentAccountId || null,
    accountIds: qbo.accountIds,
  };
  qbo.parentAccountId = parent.id;
  qbo.accountIds = ids;
  state.directory = {
    people: state.directory?.people || [],
    poTypes: state.directory?.poTypes || [],
    syncedAt: state.directory?.syncedAt || new Date().toISOString(),
    accounts: cardDescendants(qbo.accounts, parent.id).map(
      ({ subAccount, ...a }) => a,
    ),
  };
  appendAudit(state, actor, "QuickBooks purchase account scope saved", {
    before,
    after: { parentAccountId: parent.id, accountIds: ids },
    reason: input.reason,
    appliesOnNextSync: true,
  });
}
export async function saveQBOSelection(
  input: z.infer<typeof qboSelectionSchema>,
  actor: string,
) {
  return withQBOTransaction(async (db) => {
    const state = await readDB(db, true),
      count = state.audit.length;
    configuredQBO(state);
    applyQBOSelection(state, input, actor);
    state.revision++;
    await persistDB(db, state, count);
    return state;
  });
}
