const { Pool } = require("pg");
const fs = require("node:fs");
const path = require("node:path");
(async () => {
  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.PGSSL === "true" ? { rejectUnauthorized: true } : undefined,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(749221)");
    await client.query(
      fs.readFileSync(path.join(__dirname, "../db/001_initial.sql"), "utf8"),
    );
    const state = {
      revision: 0,
      mode: "live",
      records: [],
      config: {
        windowDays: 21,
        graceDays: 5,
        lateDays: 2,
        toleranceCents: 1,
        autoThreshold: 85,
        ambiguityMargin: 5,
        maxGroup: 3,
        weights: { vendor: 30, amount: 45, date: 15, reference: 10 },
      },
      rules: [],
      decisions: [],
      audit: [],
      lastSync: null,
    };
    await client.query(
      "INSERT INTO app_state(id,payload) VALUES(1,$1) ON CONFLICT(id) DO NOTHING",
      [JSON.stringify(state)],
    );
    await client.query("COMMIT");
    console.log("Migration complete");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
