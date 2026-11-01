/**
 * Seed idempotente: tenant demo + admin + tenant_settings vazio (agnóstico).
 * Sem dados de vertical — o tenant nasce vazio (cadastro 0%); amostras ficam a cargo do usuário/curl.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { env } from "../config/env.js";

export async function seedTenant(connectionString: string, slug: string, name: string, adminEmail: string) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const found = await client.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
    const tenantId: string = found.rows[0]?.id ?? randomUUID();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query("INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING",
      [tenantId, slug, name]);
    const u = await client.query(
      `INSERT INTO users (tenant_id, email, display_name, role) VALUES ($1, $2, 'Admin', 'admin')
       ON CONFLICT (tenant_id, email) DO UPDATE SET role = 'admin' RETURNING id`, [tenantId, adminEmail]);
    await client.query("INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", [tenantId]);
    await client.query("COMMIT");
    return { tenantId, adminUserId: u.rows[0].id as string };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedTenant(env.migrationDatabaseUrl, "demo", "Demo tenant", "admin@demo.local").then(
    (r) => { console.log("seed OK"); console.log(`TENANT_ID=${r.tenantId}`); console.log(`ADMIN_USER_ID=${r.adminUserId}`); },
    (e) => { console.error(e); process.exit(1); });
}
