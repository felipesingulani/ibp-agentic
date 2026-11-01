import { randomUUID } from "node:crypto";
import { env } from "../../src/config/env.js";
import { migrate } from "../../src/db/migrate.js";
import { seedTenant } from "../../src/db/seed.js";

export async function setupTwoTenants() {
  await migrate(env.migrationDatabaseUrl, () => {});
  const s = randomUUID().slice(0, 8);
  const a = await seedTenant(env.migrationDatabaseUrl, `test-a-${s}`, "Tenant A", "admin@a.test");
  const b = await seedTenant(env.migrationDatabaseUrl, `test-b-${s}`, "Tenant B", "admin@b.test");
  return { a, b };
}

/**
 * Cenário criado pela conexão owner (sem passar pelo desbloqueio do wizard) — fixture p/ testes de
 * premise_cards/A4/RLS. O fluxo real (W2) cria via POST da Wizard API (ver wizard-api.test.ts).
 */
export async function ownerCreateScenario(tenantId: string, code: string): Promise<string> {
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: env.migrationDatabaseUrl });
  await c.connect();
  try {
    return (await c.query("INSERT INTO scenarios (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenantId, code])).rows[0].id;
  } finally { await c.end(); }
}
