import { readFile } from "node:fs/promises";
import { pool, emptyState } from "../lib/store";
const { default: env } = await import("@next/env");
env.loadEnvConfig(process.cwd());
const db = pool();
const client = await db.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(749221)");
  await client.query(
    await readFile(new URL("../db/001_initial.sql", import.meta.url), "utf8"),
  );
  await client.query(
    "INSERT INTO app_state(id,payload) VALUES(1,$1) ON CONFLICT(id) DO NOTHING",
    [JSON.stringify(emptyState())],
  );
  await client.query("COMMIT");
  console.log("Database migration complete");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
  await db.end();
}
