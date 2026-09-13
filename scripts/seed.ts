import { pool } from "../lib/store";
import { seed } from "../lib/seed";
const { default: env } = await import("@next/env");
env.loadEnvConfig(process.cwd());
if (process.env.ALLOW_SEED !== "true")
  throw Error("Set ALLOW_SEED=true for a disposable test database only");
const db = pool();
try {
  const r = await db.query(
    "UPDATE app_state SET payload=$1 WHERE id=1 AND jsonb_array_length(payload->'records')=0 AND NOT EXISTS(SELECT 1 FROM audit_events)",
    [JSON.stringify(seed())],
  );
  if (!r.rowCount) throw Error("Refusing to replace nonempty workspace");
  console.log("Seeded disposable database");
} finally {
  await db.end();
}
