/**
 * Verificação pós-migrate 0018 (read-only, temporária no buildCommand). Sem writes.
 */
import pg from "pg";
import { env } from "../src/config/env.js";

const WANT = ["sales_history_period_ym", "sales_history_qty_nonneg", "sales_history_tenant_node_sku_period_source_key"];

async function main() {
  const c = new pg.Client({ connectionString: env.migrationDatabaseUrl });
  await c.connect();
  try {
    const r = await c.query(
      `SELECT conname, contype FROM pg_constraint
       WHERE conrelid = 'public.sales_history'::regclass AND conname = ANY($1) ORDER BY conname`, [WANT]);
    const m = await c.query(`SELECT id, applied_at FROM schema_migrations WHERE id LIKE '0018%'`);
    const n = await c.query(`SELECT count(*)::int AS n FROM sales_history`);
    console.log("VERIFY-0018");
    for (const row of r.rows) console.log(`CONSTRAINT ${row.conname} type=${row.contype}`);
    console.log(`FOUND=${r.rowCount}/${WANT.length}`);
    console.log(`SCHEMA_MIGRATIONS_0018=${JSON.stringify(m.rows)}`);
    console.log(`SALES_HISTORY_ROWS=${n.rows[0].n}`);
    if (r.rowCount !== WANT.length) throw new Error("constraints 0018 ausentes");
    console.log("VERIFY-0018 OK");
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error("VERIFY-0018 ERROR:", e instanceof Error ? e.message : e); process.exit(1); });
