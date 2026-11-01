// PO residual W3b (2026-10-30): sample-demo nasce com alçada publicada (default do pack generic = 2 mi); tenant vazio segue no_policy.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { makePool, withTenant } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import { seedTenant } from "../../src/db/seed.js";
import { seedDemoAlcada } from "../../src/db/seed-demo-alcada.js";
import { loadAlcadaPolicy } from "../../src/w3/alcada.js";
import { getPack } from "../../src/cadastro/packs.js";

const pool = makePool(env.databaseUrl);
const owner = new pg.Client({ connectionString: env.migrationDatabaseUrl });
const slug = () => `seed-alc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const mode = (t: string) => withTenant(pool, t, (c) => loadAlcadaPolicy(c));
before(() => owner.connect());
after(async () => { await owner.end(); await pool.end(); });

test("seedDemoAlcada: tenant demo → generic + POL alçada limitMi 2 (active); idempotente; não sobrescreve limiar existente", async () => {
  const s = slug();
  const { tenantId } = await seedTenant(env.migrationDatabaseUrl, s, "Demo", `admin@${s}.test`);
  assert.equal((await mode(tenantId)).mode, "no_policy"); // tenant vazio: fail-closed
  const r1 = await seedDemoAlcada(pool, s);
  assert.deepEqual([r1.action, r1.limitMi], ["created", 2]);
  const m = await mode(tenantId);
  assert.deepEqual([m.mode, m.policy?.alcadaMi, m.policy?.version], ["active", 2, 1]);
  const st = (await owner.query("SELECT industry_pack, policy_kinds, node_types, uom FROM tenant_settings WHERE tenant_id = $1", [tenantId])).rows[0];
  assert.deepEqual([st.industry_pack, st.policy_kinds, st.node_types, st.uom], ["generic", {}, [], null]); // resto do cadastro intacto
  const r2 = await seedDemoAlcada(pool, s);
  assert.equal(r2.action, "kept");
  assert.equal((await mode(tenantId)).policy?.version, 1);
  await owner.query("UPDATE policies SET body = '{\"limitMi\": 7}' WHERE tenant_id = $1 AND is_current AND kind = 'alcada'", [tenantId]);
  assert.deepEqual([(await seedDemoAlcada(pool, s)).action, (await mode(tenantId)).policy?.alcadaMi], ["kept", 7]);
  const au = (await owner.query("SELECT entity, action, payload->>'why' why FROM audit_log WHERE tenant_id = $1 ORDER BY at", [tenantId])).rows;
  assert.ok(au.some((a) => a.entity === "policies" && a.action === "create" && /seed/.test(a.why)));
});

test("seedDemoAlcada: out_of_pack (escolha explícita do PO) não é revertido; slug inexistente → erro; outro tenant vazio intocado", async () => {
  const s = slug(), other = slug();
  const { tenantId } = await seedTenant(env.migrationDatabaseUrl, s, "Demo", `admin@${s}.test`);
  const o = await seedTenant(env.migrationDatabaseUrl, other, "Vazio", `admin@${other}.test`);
  const noAlc = getPack("generic_no_alcada")!;
  await owner.query("UPDATE tenant_settings SET industry_pack = $2, policy_kinds = $3 WHERE tenant_id = $1", [tenantId, noAlc.profile_id, JSON.stringify(noAlc.policy_kinds)]);
  assert.equal((await seedDemoAlcada(pool, s)).action, "skipped_out_of_pack");
  assert.equal((await mode(tenantId)).mode, "out_of_pack");
  await assert.rejects(seedDemoAlcada(pool, "nope-" + s), /tenant_not_found/);
  assert.equal((await mode(o.tenantId)).mode, "no_policy");
});
