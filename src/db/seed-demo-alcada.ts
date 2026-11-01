/**
 * Seed (PO residual W3b, 2026-10-30): publica a alçada default do pack num tenant DEMO (ex.: sample-demo), para o gate/fila
 * de alçada se comportarem como o wire com alçada publicada. Tenant vazio (seed.ts) continua `no_policy` (fail-closed).
 * Mesmo caminho de `PUT /api/cadastro/alcada` (upsertAlcada → POL nova versionada + audit), sob RLS (ibp_app) + lock do tenant.
 * Idempotente: POL de alçada existente (active ou misconfigured) é mantida; `out_of_pack` (pack sem alçada) não é revertido.
 * Só marca `industry_pack = 'generic'` se NULL (NULL ≡ generic); policy_kinds/labels/node_types/uom ficam como estão.
 * Uso: npm run seed:demo-alcada [-- <slug>]   (default slug: sample-demo)
 */
import pg from "pg";
import { env } from "../config/env.js";
import { makePool, withTenant } from "./pool.js";
import { audit } from "../http/common.js";
import { genericPack, getPack } from "../cadastro/packs.js";
import { lockTenant } from "../cadastro/settings.js";
import { upsertAlcada } from "../cadastro/alcada-write.js";
import { loadAlcadaPolicy } from "../w3/alcada.js";

const WHY = "seed demo: alçada default do pack (PO 2026-10-30)";

export async function seedDemoAlcada(pool: pg.Pool, slug = "sample-demo") {
  const owner = new pg.Client({ connectionString: env.migrationDatabaseUrl }); // só p/ resolver slug → id (tenants sem RLS p/ lookup)
  await owner.connect();
  let tenantId: string, userId: string | null;
  try {
    const t = (await owner.query("SELECT id FROM tenants WHERE slug = $1", [slug])).rows[0];
    if (!t) throw new Error(`tenant_not_found: ${slug}`);
    tenantId = t.id;
    userId = (await owner.query("SELECT id FROM users WHERE tenant_id = $1 ORDER BY (role = 'admin') DESC, created_at LIMIT 1", [tenantId])).rows[0]?.id ?? null;
  } finally { await owner.end(); }
  const ctx = { tenantId, userId, role: "seed" };
  return withTenant(pool, tenantId, async (c) => {
    await lockTenant(c, tenantId);
    await c.query("INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", [tenantId]);
    const before = await loadAlcadaPolicy(c);
    if (before.mode === "out_of_pack") return { tenantId, action: "skipped_out_of_pack" as const, limitMi: null };
    if (before.mode !== "no_policy") return { tenantId, action: "kept" as const, limitMi: before.policy?.alcadaMi ?? null };
    const cur = (await c.query("SELECT industry_pack FROM tenant_settings")).rows[0]?.industry_pack as string | null;
    if (cur === null) {
      await c.query("UPDATE tenant_settings SET industry_pack = 'generic', updated_at = now()");
      await audit(c, ctx, "update", "tenant_settings", tenantId, { why: WHY, action: "seed_industry_pack", from: null, to: "generic" });
    }
    const limitMi = (getPack(cur ?? "generic") ?? genericPack()).alcada?.defaultLimitMi ?? genericPack().alcada!.defaultLimitMi;
    const r = await upsertAlcada(c, ctx, limitMi, WHY);
    return { tenantId, action: r.action, limitMi, policyId: r.policy.stable_id };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = makePool(env.databaseUrl);
  seedDemoAlcada(pool, process.argv[2] ?? "sample-demo").then(
    (r) => { console.log("seed:demo-alcada OK", JSON.stringify(r)); return pool.end(); },
    async (e) => { console.error(e); await pool.end(); process.exit(1); });
}
