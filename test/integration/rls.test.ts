// RLS no banco (role do app, sem BYPASSRLS): sem app.tenant_id não vê nada; com tenant A não vê B; não grava em B.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { makePool, withTenant } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import { ownerCreateScenario, setupTwoTenants } from "./helpers.js";

const pool = makePool(env.databaseUrl);
let A: string, B: string;
const tables = ["tenants", "users", "policies", "nodes", "node_capacity", "routes", "skus",
  "supplier_contracts", "sales_history", "finance_drivers", "audit_log", "tenant_settings",
  "nodes_identity", "skus_identity", "premise_cards", "scenarios", "a4_runs", "decision_events"];

before(async () => {
  const t = await setupTwoTenants();
  A = t.a.tenantId; B = t.b.tenantId;
  for (const [tid, code] of [[A, "A-1"], [B, "B-1"]]) {
    await withTenant(pool, tid, (c) =>
      c.query("INSERT INTO nodes (tenant_id, code, name, node_type) VALUES ($1, $2, 'n', 'outro')", [tid, code]));
  }
});
after(() => pool.end());

test("app role is not superuser and has no BYPASSRLS", async () => {
  const r = await pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
  assert.deepEqual(r.rows[0], { rolsuper: false, rolbypassrls: false });
});

test("every cadastro table has RLS enabled + at least one policy", async () => {
  const r = await pool.query(
    `SELECT c.relname, c.relrowsecurity, (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS n
       FROM pg_class c WHERE c.relname = ANY($1) AND c.relkind = 'r'`, [tables]);
  assert.equal(r.rowCount, tables.length);
  for (const row of r.rows) {
    assert.equal(row.relrowsecurity, true, `${row.relname} RLS`);
    assert.ok(row.n >= 1, `${row.relname} has policy`);
  }
});

test("without app.tenant_id no rows leak from any table", async () => {
  for (const t of tables) {
    const r = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
    assert.equal(r.rows[0].n, 0, `${t} leaked without tenant`);
  }
});

test("tenant A sees only its own rows", async () => {
  const codes = await withTenant(pool, A, (c) => c.query("SELECT tenant_id, code FROM nodes").then((q) => q.rows));
  assert.ok(codes.length >= 1);
  assert.ok(codes.every((r) => r.tenant_id === A));
  assert.ok(!codes.some((r) => r.code === "B-1"));
});

test("tenant A cannot insert rows for tenant B (WITH CHECK)", async () => {
  await assert.rejects(
    withTenant(pool, A, (c) =>
      c.query("INSERT INTO nodes (tenant_id, code, name, node_type) VALUES ($1, 'X', 'x', 'outro')", [B])),
    (e: { code?: string }) => e.code === "42501");
});

test("W2 grants: app reads/writes own scenarios (no delete, no cross-tenant), reads/writes a4_runs (no delete)", async () => {
  await withTenant(pool, A, (c) => c.query("SELECT 1 FROM decision_events")); // 0012 (Task 7): SELECT+INSERT
  await withTenant(pool, A, (c) => c.query("SELECT 1 FROM scenarios"));
  await withTenant(pool, A, (c) => c.query("SELECT 1 FROM a4_runs"));
  // 0011: INSERT/UPDATE no próprio tenant
  const code = `RLS-W2-${Date.now()}`;
  const own = await withTenant(pool, A, (c) =>
    c.query("INSERT INTO scenarios (tenant_id, code, name) VALUES ($1, $2, 'x') RETURNING id", [A, code]).then((q) => q.rows[0].id));
  await withTenant(pool, A, (c) => c.query("UPDATE scenarios SET name = 'y' WHERE id = $1", [own]));
  // cross-tenant: WITH CHECK nega insert p/ B; B não enxerga/atualiza o de A
  await assert.rejects(withTenant(pool, A, (c) =>
    c.query("INSERT INTO scenarios (tenant_id, code, name) VALUES ($1, 'X', 'x')", [B])),
  (e: { code?: string }) => e.code === "42501", "scenarios cross-tenant insert");
  assert.equal(await withTenant(pool, B, (c) => c.query("UPDATE scenarios SET name = 'hack' WHERE id = $1", [own]).then((q) => q.rowCount)), 0);
  await assert.rejects(withTenant(pool, A, (c) => c.query("DELETE FROM scenarios WHERE id = $1", [own])),
    (e: { code?: string }) => e.code === "42501", "scenarios delete");
  await assert.rejects(withTenant(pool, A, (c) => c.query("DELETE FROM a4_runs")),
    (e: { code?: string }) => e.code === "42501", "a4_runs delete");
  const f = await pool.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('scenarios','a4_runs') ORDER BY 1");
  assert.deepEqual(f.rows.map((r) => [r.relname, r.relrowsecurity, r.relforcerowsecurity]), [["a4_runs", true, true], ["scenarios", true, true]]);
});

test("a4_runs RLS: tenant B cannot see A's run nor insert one for A's scenario", async () => {
  const scA = await ownerCreateScenario(A, `RLS-${Date.now()}`);
  await withTenant(pool, A, (c) => c.query(
    "INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status) VALUES ($1, 'RLS-RUN', $2, 1, 'queued')", [A, scA]));
  assert.equal(await withTenant(pool, B, (c) => c.query("SELECT 1 FROM a4_runs WHERE scenario_id = $1", [scA]).then((q) => q.rowCount)), 0);
  assert.equal(await withTenant(pool, B, (c) => c.query("SELECT 1 FROM scenarios WHERE id = $1", [scA]).then((q) => q.rowCount)), 0);
  await assert.rejects(withTenant(pool, B, (c) => c.query(
    "INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status) VALUES ($1, 'X', $2, 1, 'queued')", [B, scA])),
  (e: { code?: string }) => e.code === "23503" || e.code === "42501");
  await assert.rejects(withTenant(pool, B, (c) => c.query(
    "INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status) VALUES ($1, 'X', $2, 1, 'queued')", [A, scA])),
  (e: { code?: string }) => e.code === "42501");
});

test("composite FK (tenant_id, stable_id): DB rejects cross-tenant node reference even bypassing the API", async () => {
  const aNode = await withTenant(pool, A, (c) =>
    c.query("SELECT stable_id FROM nodes WHERE code = 'A-1'").then((q) => q.rows[0].stable_id));
  await assert.rejects(
    withTenant(pool, B, (c) =>
      c.query("INSERT INTO node_capacity (tenant_id, node_id, capacity_t_month) VALUES ($1, $2, 1)", [B, aNode])),
    (e: { code?: string }) => e.code === "23503");
  // same-tenant works with stable_id
  await withTenant(pool, A, (c) =>
    c.query("INSERT INTO node_capacity (tenant_id, node_id, capacity_t_month) VALUES ($1, $2, 1)", [A, aNode]));
});

test("only one current version per stable_id (partial unique index)", async () => {
  await assert.rejects(withTenant(pool, A, async (c) => {
    const sid = (await c.query("SELECT stable_id FROM nodes WHERE code = 'A-1'")).rows[0].stable_id;
    await c.query("INSERT INTO nodes (tenant_id, stable_id, code, name, node_type, version) VALUES ($1, $2, 'A-1', 'n', 'x', 2)", [A, sid]);
  }), (e: { code?: string }) => e.code === "23505");
});

test("premise_cards: FORCE RLS + composite FK (tenant_id, node_id) → nodes_identity rejects cross-tenant node", async () => {
  const f = await pool.query("SELECT relforcerowsecurity FROM pg_class WHERE relname = 'premise_cards'");
  assert.equal(f.rows[0].relforcerowsecurity, true);
  const aNode = await withTenant(pool, A, (c) =>
    c.query("SELECT stable_id FROM nodes WHERE code = 'A-1'").then((q) => q.rows[0].stable_id));
  const scnB = await ownerCreateScenario(B, "SCN-RLS-B");
  const scnA = await ownerCreateScenario(A, "SCN-RLS-A");
  const ins = (tid: string, scn: string, node: string) => withTenant(pool, tid, (c) => c.query(
    `INSERT INTO premise_cards (tenant_id, scenario_id, card_id, type, status, node_id, source)
     VALUES ($1, $2, 'PC-R', 'Gap', 'gap', $3, 'edit')`, [tid, scn, node]));
  await assert.rejects(ins(B, scnB, aNode), (e: { code?: string }) => e.code === "23503");
  await assert.rejects(ins(A, scnB, aNode), (e: { code?: string }) => e.code === "23503"); // cenário de outro tenant
  await ins(A, scnA, aNode);
  // CHECK do contrato preservado: Gap sem node_id
  await assert.rejects(withTenant(pool, A, (c) => c.query(
    `INSERT INTO premise_cards (tenant_id, scenario_id, card_id, type, status, source) VALUES ($1, $2, 'PC-R2', 'Gap', 'gap', 'edit')`,
    [A, scnA])), (e: { code?: string }) => e.code === "23514");
  // B não vê o card de A
  const n = await withTenant(pool, B, (c) => c.query("SELECT count(*)::int n FROM premise_cards WHERE tenant_id = $1", [A]));
  assert.equal(n.rows[0].n, 0);
});

test("0012 decision_events: append-only (no UPDATE/DELETE), FORCE RLS, no cross-tenant insert, composite FKs (scenario/run same tenant + run of same scenario)", async () => {
  const scA = await ownerCreateScenario(A, `DEC-A-${Date.now()}`);
  const scA2 = await ownerCreateScenario(A, `DEC-A2-${Date.now()}`);
  const scB = await ownerCreateScenario(B, `DEC-B-${Date.now()}`);
  const runA = await withTenant(pool, A, (c) => c.query(
    "INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status) VALUES ($1, 'DEC-RUN', $2, 1, 'feasible') RETURNING id",
    [A, scA]).then((q) => q.rows[0].id));
  const ins = (tid: string, ten: string, sc: string, run: string | null, role = "domain_owner") => withTenant(pool, tid, (c) => c.query(
    `INSERT INTO decision_events (tenant_id, scenario_id, scenario_version, run_id, action, why, actor_role)
     VALUES ($1, $2, 1, $3, 'approve', 'porque sim', $4) RETURNING id`, [ten, sc, run, role]).then((q) => q.rows[0].id));
  const own = await ins(A, A, scA, runA);
  assert.equal(await withTenant(pool, B, (c) => c.query("SELECT 1 FROM decision_events WHERE id = $1", [own]).then((q) => q.rowCount)), 0);
  const code = (e: unknown, ...ok: string[]) => ok.includes((e as { code?: string }).code ?? "");
  await assert.rejects(withTenant(pool, A, (c) => c.query("UPDATE decision_events SET why = 'x' WHERE id = $1", [own])), (e) => code(e, "42501"), "update");
  await assert.rejects(withTenant(pool, A, (c) => c.query("DELETE FROM decision_events WHERE id = $1", [own])), (e) => code(e, "42501"), "delete");
  await assert.rejects(ins(A, B, scB, null), (e) => code(e, "42501"), "WITH CHECK: insert for B while A");
  await assert.rejects(ins(B, B, scA, null), (e) => code(e, "23503"), "B → A's scenario (composite FK)");
  await assert.rejects(ins(B, B, scB, runA), (e) => code(e, "23503"), "B → A's run");
  await assert.rejects(ins(A, A, scA2, runA), (e) => code(e, "23503"), "run of another scenario");
  await assert.rejects(ins(A, A, scA, null, "admin"), (e) => code(e, "23514"), "actor_role outside contract enum");
  const f = await pool.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'decision_events'");
  assert.deepEqual(f.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
});
