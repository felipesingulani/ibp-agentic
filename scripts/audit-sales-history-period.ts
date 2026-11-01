/**
 * One-shot Neon audit for T-DM-PERIOD-GRAIN + T-DM-SALESHIST-UQ (read-only).
 * Prints counts for PO/Deivid before migrate. No writes.
 */
import pg from "pg";
import { env } from "../src/config/env.js";

async function main() {
  const c = new pg.Client({ connectionString: env.migrationDatabaseUrl });
  await c.connect();
  try {
    const total = await c.query(`SELECT count(*)::int AS n FROM sales_history`);
    const badLen = await c.query(`
      SELECT count(*)::int AS n FROM sales_history WHERE length(period) <> 7`);
    const samples = await c.query(`
      SELECT period, count(*)::int AS n
      FROM sales_history
      WHERE length(period) <> 7
      GROUP BY 1 ORDER BY n DESC LIMIT 20`);
    const dups = await c.query(`
      SELECT count(*)::int AS groups FROM (
        SELECT tenant_id, node_id, sku_id, period, coalesce(source,'') AS src, count(*) AS c
        FROM sales_history
        GROUP BY 1,2,3,4,5
        HAVING count(*) > 1
      ) t`);
    const dupSamples = await c.query(`
      SELECT tenant_id::text, node_id::text, sku_id::text, period, coalesce(source,'') AS source, count(*)::int AS c
      FROM sales_history
      GROUP BY 1,2,3,4,5
      HAVING count(*) > 1
      ORDER BY c DESC LIMIT 20`);
    const monthOk = await c.query(`
      SELECT count(*)::int AS n FROM sales_history
      WHERE period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`);
    console.log("AUDIT-SALES-HISTORY-PERIOD");
    console.log(`TOTAL_ROWS=${total.rows[0].n}`);
    console.log(`PERIOD_LEN_NE_7=${badLen.rows[0].n}`);
    console.log(`PERIOD_YM_OK=${monthOk.rows[0].n}`);
    console.log(`DUP_GROUPS=${dups.rows[0].groups}`);
    console.log("SAMPLES_LEN_NE_7=" + JSON.stringify(samples.rows));
    console.log("SAMPLES_DUPS=" + JSON.stringify(dupSamples.rows));
    console.log("AUDIT-SALES-HISTORY-PERIOD OK");
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error("AUDIT-SALES-HISTORY-PERIOD ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
