/**
 * Migration runner (owner connection = MIGRATION_DATABASE_URL).
 * 0001 = contracts/v0-postgres-cadastro.sql (contrato do Deivid, não editado).
 *   - Se o compose já aplicou via docker-entrypoint-initdb.d, só registra como baseline.
 * 0002+ = db/migrations/*.sql (aditivas), cada uma numa transação, aplicadas uma vez.
 * Serializado por pg_advisory_lock (sessão; liberado ao fechar a conexão).
 * Garante a role do app (CREATE: NOSUPERUSER NOBYPASSRLS; ALTER no Neon: só LOGIN+PASSWORD — owner sem SUPERUSER).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { env } from "../config/env.js";

const CONTRACT = "contracts/v0-postgres-cadastro.sql";

export async function migrate(connectionString = env.migrationDatabaseUrl, log = console.log): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // serializa runners concorrentes (ex.: arquivos de teste em paralelo) — evita "tuple concurrently updated" no ALTER ROLE
    await client.query("SELECT pg_advisory_lock(hashtext('ibp_schema_migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), note text)`);
    const applied = new Set((await client.query("SELECT id FROM schema_migrations")).rows.map((r) => r.id));

    // 0001 baseline: contrato
    if (!applied.has("0001_contract_cadastro")) {
      const exists = (await client.query("SELECT to_regclass('public.tenants') AS t")).rows[0].t;
      await client.query("BEGIN");
      if (exists) {
        await client.query("INSERT INTO schema_migrations (id, note) VALUES ($1, $2)",
          ["0001_contract_cadastro", "baseline: applied by docker-entrypoint-initdb.d"]);
        log("0001_contract_cadastro: baseline (já aplicado pelo compose init)");
      } else {
        await client.query(readFileSync(CONTRACT, "utf8"));
        await client.query("INSERT INTO schema_migrations (id, note) VALUES ($1, $2)",
          ["0001_contract_cadastro", "applied from " + CONTRACT]);
        log("0001_contract_cadastro: applied");
      }
      await client.query("COMMIT");
    }

    // Role do app (idempotente). Senha via env, escapada (DDL não aceita bind params).
    const user = env.appDbUser;
    if (!/^[a-z_][a-z0-9_]*$/.test(user)) throw new Error("APP_DB_USER inválido");
    const pw = client.escapeLiteral(env.appDbPassword);
    const roleExists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [user])).rowCount;
    // Neon: neondb_owner não é SUPERUSER — ALTER … NOSUPERUSER/NOBYPASSRLS falha com 42501.
    // CREATE com esses attrs ok; no re-run só refresh de LOGIN+PASSWORD (+ attrs que não tocam SUPERUSER/BYPASSRLS).
    if (roleExists) {
      await client.query(`ALTER ROLE ${user} LOGIN NOCREATEDB NOCREATEROLE PASSWORD ${pw}`);
      log(`role ${user}: password refreshed (LOGIN; skip NOSUPERUSER/NOBYPASSRLS — Neon)`);
    } else {
      await client.query(`CREATE ROLE ${user} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${pw}`);
      log(`role ${user}: created (NOSUPERUSER NOBYPASSRLS)`);
    }

    const dir = "db/migrations";
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      const id = f.replace(/\.sql$/, "");
      if (applied.has(id)) { log(`${id}: already applied`); continue; }
      let sql = readFileSync(join(dir, f), "utf8");
      if (user !== "ibp_app") sql = sql.replaceAll("ibp_app", user);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
        await client.query("COMMIT");
        log(`${id}: applied`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`${id} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(() => console.log("migrate OK"), (e) => { console.error(e); process.exit(1); });
}
