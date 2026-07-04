const pool = require("../db/connection");
const { listMigrations, migrate } = require("../db/migrate");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  await migrate();
  await migrate();

  const applied = await pool.query(
    "SELECT version FROM schema_migrations ORDER BY version"
  );
  const expected = listMigrations();
  assert(applied.rowCount === expected.length, "expected every migration to be recorded once");
  assert(
    applied.rows.every((row, index) => row.version === expected[index]),
    "expected migrations to be applied in filename order"
  );

  const columns = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'transactions'
      AND column_name IN ('client_id', 'card_fingerprint', 'lease_expires_at')
  `);
  assert(columns.rowCount === 3, "expected upgraded transaction schema");

  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('issuer_accounts', 'issuer_ledger_entries', 'settlement_records')
  `);
  assert(tables.rowCount === 3, "expected issuer ledger and settlement tables");

  console.log("PASS ordered migrations are complete and idempotent");
  await pool.end();
}

main().catch(async (error) => {
  console.error("FAIL", error.stack || error.message || error);
  await pool.end();
  process.exit(1);
});
