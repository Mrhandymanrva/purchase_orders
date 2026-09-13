import { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { seed } from "./seed";
import { defaults, type State, type Audit } from "./domain";
export type DB = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};
const globalStore = globalThis as unknown as {
  richmondPool?: Pool;
  richmondDemo?: State;
  richmondQueue?: Promise<unknown>;
};
export class Conflict extends Error {}
export function pool() {
  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required");
  return (globalStore.richmondPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
    ssl:
      process.env.PGSSL === "true" ? { rejectUnauthorized: true } : undefined,
  }));
}
export function demoMode() {
  return (
    process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production"
  );
}
export function emptyState(): State {
  return {
    revision: 0,
    mode: "live",
    records: [],
    config: structuredClone(defaults),
    rules: [],
    decisions: [],
    audit: [],
    lastSync: null,
  };
}
export async function readDB(db: DB, lock = false): Promise<State> {
  const r = await db.query(
    "SELECT payload FROM app_state WHERE id=1" + (lock ? " FOR UPDATE" : ""),
  );
  if (!r.rows[0]) throw Error("Database is not initialized; run db:migrate");
  const events = await db.query(
    'SELECT id, at, actor, action, detail, previous_hash AS "previousHash", hash FROM audit_events ORDER BY sequence',
  );
  return {
    ...r.rows[0].payload,
    audit: events.rows.map((a) => ({ ...a, at: new Date(a.at).toISOString() })),
  };
}
export async function readState() {
  if (demoMode()) return structuredClone((globalStore.richmondDemo ??= seed()));
  return readDB(pool());
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function appendAudit(
  state: State,
  actor: string,
  action: string,
  detail: unknown,
) {
  const previousHash = state.audit.at(-1)?.hash || "GENESIS";
  const event = {
    id: randomUUID(),
    at: new Date().toISOString(),
    actor,
    action,
    detail: structuredClone(detail),
    previousHash,
  };
  const hash = createHash("sha256").update(canonical(event)).digest("hex");
  state.audit.push({ ...event, hash });
}
export function verifyAudit(events: Audit[]) {
  let previous = "GENESIS";
  for (const { hash, ...event } of events) {
    if (
      event.previousHash !== previous ||
      createHash("sha256").update(canonical(event)).digest("hex") !== hash
    )
      return false;
    previous = hash;
  }
  return true;
}
export async function persistDB(db: DB, state: State, oldAuditCount: number) {
  for (const a of state.audit.slice(oldAuditCount))
    await db.query(
      "INSERT INTO audit_events(id,at,actor,action,detail,previous_hash,hash) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        a.id,
        a.at,
        a.actor,
        a.action,
        JSON.stringify(a.detail),
        a.previousHash,
        a.hash,
      ],
    );
  await db.query(
    "UPDATE app_state SET payload=$1, updated_at=now() WHERE id=1",
    [JSON.stringify({ ...state, audit: [] })],
  );
}
export async function changeState(
  revision: number,
  fn: (s: State) => Promise<void> | void,
): Promise<State> {
  if (demoMode()) {
    const run = async () => {
      const state = await readState();
      if (state.revision !== revision)
        throw new Conflict("Workspace changed. Refresh the page and retry.");
      await fn(state);
      state.revision++;
      globalStore.richmondDemo = state;
      return structuredClone(state);
    };
    const next = (globalStore.richmondQueue ?? Promise.resolve()).then(run);
    globalStore.richmondQueue = next.catch(() => {});
    return next;
  }
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const state = await readDB(client, true);
    if (state.revision !== revision)
      throw new Conflict("Workspace changed. Refresh the page and retry.");
    const count = state.audit.length;
    await fn(state);
    state.revision++;
    await persistDB(client, state, count);
    await client.query("COMMIT");
    return state;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
