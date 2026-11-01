// W4 · Task 10 — execução: 0014 (FORCE RLS, grant mínimo, void-only), POST/batch (all-or-nothing)/void/GET, Pulse (fonte execution,
// limiar 15%, block, aderência), unapproved_plan, RLS cross-tenant. Fixtures via owner; API via app (RLS).
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { createApp } from "../../src/http/app.js";
import { makePool, withTenant } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import { ownerCreateScenario, setupTwoTenants } from "./helpers.js";
import { validateExecutionMovement } from "../support/schemas.js";

const pool = makePool(env.databaseUrl);
const owner = new pg.Client({ connectionString: env.migrationDatabaseUrl });
type Who = { tenantId: string; userId: string | null };
let server: { close(): void }, base = "";
async function call(who: Who | null, method: string, path: string, body?: unknown) {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (who) h["x-tenant-id"] = who.tenantId;
  if (who?.userId) h["x-user-id"] = who.userId;
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const q = (sql: string, p: unknown[] = []) => owner.query(sql, p).then((r) => r.rows);
const code = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const M = "/api/execution/movements";

before(async () => {
  await owner.connect();
  server = createApp(pool).listen(0);
  await new Promise<void>((r) => (server as unknown as { once(e: string, f: () => void): void }).once("listening", r));
  base = `http://127.0.0.1:${((server as unknown as { address(): AddressInfo }).address()).port}`;
});
after(async () => { server.close(); await owner.end(); await pool.end(); });

async function world(approve = true) {
  const t = await setupTwoTenants();
  const A = { tenantId: t.a.tenantId, userId: t.a.adminUserId }, B = { tenantId: t.b.tenantId, userId: t.b.adminUserId };
  const sc = await ownerCreateScenario(A.tenantId, code("SC"));
  const run = (await q(`INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status, plan, finished_at)
    VALUES ($1,$2,$3,1,'feasible','{"totals":{"fillRate":0.9}}', now()) RETURNING id`, [A.tenantId, code("R"), sc]))[0].id as string;
  if (approve) await q(`INSERT INTO decision_events (tenant_id, scenario_id, scenario_version, run_id, action, why, actor_role)
    VALUES ($1,$2,1,$3,'approve','ok plano','domain_owner')`, [A.tenantId, sc, run]);
  const node = (await q("INSERT INTO nodes (tenant_id, code, name, node_type) VALUES ($1,'CD1','CD 1','cd') RETURNING stable_id", [A.tenantId]))[0].stable_id as string;
  const sku = (await q("INSERT INTO skus (tenant_id, code, name) VALUES ($1,'K1','K1') RETURNING stable_id", [A.tenantId]))[0].stable_id as string;
  return { A, B, sc, run, node, sku };
}

test("0014: FORCE RLS, FKs compostas, grant mínimo (SELECT/INSERT + UPDATE só status), sem DELETE; trigger só posted→void", async () => {
  const [rls] = await q("SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE relname = 'execution_movements'");
  assert.deepEqual([rls.r, rls.f], [true, true]);
  const fks = (await q("SELECT conname FROM pg_constraint WHERE conrelid = 'execution_movements'::regclass AND contype = 'f' ORDER BY 1")).map((r) => r.conname);
  for (const k of ["execution_movements_node_fk", "execution_movements_run_fk", "execution_movements_sku_fk"]) assert.ok(fks.includes(k), k);
  const tbl = (await q("SELECT privilege_type p FROM information_schema.role_table_grants WHERE table_name = 'execution_movements' AND grantee = 'ibp_app' ORDER BY 1")).map((r) => r.p);
  assert.deepEqual(tbl, ["INSERT", "SELECT"]);
  const col = (await q("SELECT column_name c FROM information_schema.column_privileges WHERE table_name = 'execution_movements' AND grantee = 'ibp_app' AND privilege_type = 'UPDATE'")).map((r) => r.c);
  assert.deepEqual(col, ["status"]);
  const { A, run, sc } = await world();
  const id = (await q(`INSERT INTO execution_movements (tenant_id, plan_run_id, scenario_id, scenario_version, period_start, kind, qty_actual)
    VALUES ($1,$2,$3,1,'2026-10-26','ship',5) RETURNING id`, [A.tenantId, run, sc]))[0].id;
  await assert.rejects(withTenant(pool, A.tenantId, (c) => c.query("UPDATE execution_movements SET qty_actual = 9 WHERE id = $1", [id])), /permission denied/);
  await assert.rejects(withTenant(pool, A.tenantId, (c) => c.query("DELETE FROM execution_movements WHERE id = $1", [id])), /permission denied/);
  await q("UPDATE execution_movements SET status = 'void' WHERE id = $1", [id]);
  await assert.rejects(q("UPDATE execution_movements SET status = 'posted' WHERE id = $1", [id]), /só posted → void/);
  // run de OUTRO cenário → FK composta recusa
  const sc2 = await ownerCreateScenario(A.tenantId, code("SC"));
  await assert.rejects(q(`INSERT INTO execution_movements (tenant_id, plan_run_id, scenario_id, scenario_version, period_start, kind, qty_actual)
    VALUES ($1,$2,$3,1,'2026-10-26','ship',5)`, [A.tenantId, run, sc2]), /execution_movements_run_fk/);
});

test("empty tenant: sem movimentos → lista vazia, pending.executionExceptions 0, aderência null (no_plan), nenhuma exceção execution", async () => {
  const { A } = await setupTwoTenants().then((t) => ({ A: { tenantId: t.a.tenantId, userId: t.a.adminUserId } }));
  assert.deepEqual((await call(A, "GET", M)).json, { data: [], count: 0 });
  const s = (await call(A, "GET", "/api/pulse/summary")).json.data;
  assert.equal(s.pending.executionExceptions, 0);
  assert.deepEqual([s.execution.movements, s.execution.adherence.value, s.execution.adherence.nullReason], [0, null, "no_plan"]);
  assert.ok(!(await call(A, "GET", "/api/pulse/exceptions")).json.data.some((e: { source: string }) => e.source === "execution"));
});

test("POST movement: 201 no contrato (ajv) + audit; 401/400/409 de validação e âncora; sem movimento aderência null (no_data)", async () => {
  const { A, run, sc, node, sku } = await world();
  const s0 = (await call(A, "GET", "/api/pulse/summary")).json.data;
  assert.deepEqual([s0.planRef.basis, s0.execution.adherence.value, s0.execution.adherence.nullReason], ["approved", null, "no_data"]);
  const body = { planRunId: run, periodStart: "2026-10-26", kind: "ship", qtyPlanned: 100, qtyActual: 95, nodeId: node, skuId: sku, note: "doca 2" };
  const r = await call(A, "POST", M, body);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.ok(validateExecutionMovement(r.json.data), JSON.stringify(validateExecutionMovement.errors));
  assert.deepEqual([r.json.data.scenarioId, r.json.data.scenarioVersion, r.json.data.status, r.json.data.source, r.json.data.periodStart, r.json.data.tags],
    [sc, 1, "posted", "api", "2026-10-26", []]);
  const au = await q("SELECT action, payload FROM audit_log WHERE entity = 'execution_movements' AND entity_id = $1", [r.json.data.id]);
  assert.equal(au.length, 1); assert.equal(au[0].action, "create"); assert.equal(au[0].payload.qtyActual, 95);
  assert.equal((await call({ ...A, userId: null }, "POST", M, body)).status, 401);
  for (const bad of [{ ...body, kind: "fly" }, { ...body, qtyActual: -1 }, { ...body, periodStart: "2026-13-01" }, { ...body, extra: 1 },
    { ...body, periodStart: "2026-10-26T10:00:00Z" }]) assert.equal((await call(A, "POST", M, bad)).status, 400, JSON.stringify(bad));
  const r404 = await call(A, "POST", M, { ...body, planRunId: "00000000-0000-4000-8000-000000000000" });
  assert.deepEqual([r404.status, r404.json.error, r404.json.details.field], [400, "invalid_reference", "planRunId"]);
  const mm = await call(A, "POST", M, { ...body, scenarioId: await ownerCreateScenario(A.tenantId, code("SC")) });
  assert.deepEqual([mm.status, mm.json.error], [409, "plan_run_mismatch"]);
  const failed = (await q(`INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status) VALUES ($1,$2,$3,1,'failed') RETURNING id`,
    [A.tenantId, code("R"), sc]))[0].id;
  assert.deepEqual([(await call(A, "POST", M, { ...body, planRunId: failed })).json.error], ["run_not_done"]);
  assert.equal((await call(A, "POST", M, { ...body, nodeId: "00000000-0000-4000-8000-000000000001" })).json.error, "invalid_reference");
});

test("batch all-or-nothing (≤100, rollback c/ index) → Pulse: warn >15%, block planned>0 actual=0, =15% não; aderência real; void tira do Pulse", async () => {
  const { A, run, sc, node, sku } = await world();
  const mv = (o: Record<string, unknown>) => ({ planRunId: run, periodStart: "2026-10-26", kind: "ship", nodeId: node, skuId: sku, ...o });
  const bad = await call(A, "POST", M + ":batch", { movements: [mv({ qtyPlanned: 100, qtyActual: 80 }), mv({ qtyActual: 1, nodeId: "00000000-0000-4000-8000-000000000002" })] });
  assert.deepEqual([bad.status, bad.json.error, bad.json.details.index], [400, "invalid_reference", 1]);
  assert.equal((await call(A, "GET", M)).json.count, 0); // rollback: nem a linha 0 ficou
  const many = await call(A, "POST", M + ":batch", { movements: Array.from({ length: 101 }, () => mv({ qtyActual: 1 })) });
  assert.equal(many.status, 400);
  assert.equal((await call(A, "POST", M + ":batch", { movements: [] })).status, 400);
  const ok = await call(A, "POST", M + ":batch", { movements: [
    mv({ periodStart: "2026-10-26", qtyPlanned: 100, qtyActual: 80 }),                 // −20% → warn janela
    mv({ periodStart: "2026-10-27", kind: "produce", qtyPlanned: 50, qtyActual: 0 }),  // block capacidade
    mv({ periodStart: "2026-10-28", qtyPlanned: 100, qtyActual: 115 }),                // +15% exato → nada
  ] });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.count, 3);
  for (const d of ok.json.data) assert.ok(validateExecutionMovement(d));
  const ex = (await call(A, "GET", "/api/pulse/exceptions")).json.data.filter((e: { source: string }) => e.source === "execution");
  assert.deepEqual(ex.map((e: { severity: string; kind: string; refs: { period: string } }) => [e.severity, e.kind, e.refs.period]),
    [["block", "capacidade", "2026-10-27"], ["warn", "janela", "2026-10-26"]]);
  assert.ok(ex.every((e: { scenarioId: string; refs: { nodeId: string }; tags: string[] }) => e.scenarioId === sc && e.refs.nodeId === node && e.tags.length === 0));
  let s = (await call(A, "GET", "/api/pulse/summary")).json.data;
  assert.equal(s.pending.executionExceptions, 2);
  assert.deepEqual([s.execution.movements, s.execution.adherence.value, s.execution.adherence.buckets], [3, 0.66, 3]); // 1 − (20+50+15)/250
  assert.ok(s.kpis.find((k: { key: string }) => k.key === "viol").value >= 2); // viol conta block+warn reais
  // void (why obrigatório) → histórico preservado, Pulse recalcula
  const blockId = ok.json.data[1].id;
  assert.equal((await call(A, "POST", `${M}/${blockId}/void`, {})).status, 400);
  assert.equal((await call(A, "POST", `${M}/${blockId}/void`, { why: "  " })).status, 400);
  const v = await call(A, "POST", `${M}/${blockId}/void`, { why: "lançado no dia errado" });
  assert.deepEqual([v.status, v.json.data.status], [200, "void"]);
  assert.equal((await call(A, "POST", `${M}/${blockId}/void`, { why: "de novo" })).json.error, "already_void");
  assert.equal((await call(A, "POST", `${M}/00000000-0000-4000-8000-000000000003/void`, { why: "x" })).status, 404);
  assert.equal((await call(A, "GET", M)).json.count, 2);
  assert.equal((await call(A, "GET", `${M}?status=void`)).json.data[0].id, blockId);
  assert.equal((await call(A, "GET", `${M}?status=all&kind=produce`)).json.count, 1);
  assert.equal((await call(A, "GET", `${M}?from=2026-10-27&to=2026-10-28`)).json.count, 1);
  assert.equal((await call(A, "GET", `${M}?planRunId=${run}&from=2026-10-26&to=2026-10-26`)).json.count, 1);
  for (const bq of ["?kind=fly", "?from=26-10-2026", "?status=x", "?from=2026-10-28&to=2026-10-26", "?foo=1"])
    assert.equal((await call(A, "GET", M + bq)).status, 400, bq);
  const au = await q("SELECT payload->>'why' why FROM audit_log WHERE entity = 'execution_movements' AND action = 'void' AND entity_id = $1", [blockId]);
  assert.equal(au[0].why, "lançado no dia errado");
  s = (await call(A, "GET", "/api/pulse/summary")).json.data;
  assert.deepEqual([s.pending.executionExceptions, s.execution.movements, s.execution.adherence.value], [1, 2, 0.825]);
});

test("run sem approve (planRef latest_run): aceito + tag unapproved_plan no movimento e na exceção", async () => {
  const { A, run } = await world(false);
  const r = await call(A, "POST", M, { planRunId: run, periodStart: "2026-10-26", kind: "receive", qtyPlanned: 10, qtyActual: 0 });
  assert.equal(r.status, 201); assert.deepEqual(r.json.data.tags, ["unapproved_plan"]);
  const ex = (await call(A, "GET", "/api/pulse/exceptions")).json;
  assert.equal(ex.planRef.basis, "latest_run");
  const e = ex.data.find((x: { source: string }) => x.source === "execution");
  assert.deepEqual([e.severity, e.kind, e.tags, e.refs.nodeId], ["block", "janela", ["unapproved_plan"], null]);
  assert.match(e.summary, /rede/);
});

test("RLS cross-tenant: B não vê/usa/anula movimentos nem runs de A; INSERT com tenant de A recusado", async () => {
  const { A, B, run, sc } = await world();
  const a = (await call(A, "POST", M, { planRunId: run, periodStart: "2026-10-26", kind: "ship", qtyPlanned: 10, qtyActual: 1 })).json.data;
  assert.deepEqual((await call(B, "GET", M)).json, { data: [], count: 0 });
  assert.equal((await call(B, "GET", `${M}?status=all&planRunId=${run}`)).json.count, 0);
  assert.equal((await call(B, "POST", M, { planRunId: run, periodStart: "2026-10-26", kind: "ship", qtyActual: 1 })).json.error, "invalid_reference");
  assert.equal((await call(B, "POST", `${M}/${a.id}/void`, { why: "x" })).status, 404);
  assert.ok(!(await call(B, "GET", "/api/pulse/exceptions")).json.data.some((e: { source: string }) => e.source === "execution"));
  assert.equal((await call(B, "GET", "/api/pulse/summary")).json.data.pending.executionExceptions, 0);
  await assert.rejects(withTenant(pool, B.tenantId, (c) => c.query(
    `INSERT INTO execution_movements (tenant_id, plan_run_id, scenario_id, scenario_version, period_start, kind, qty_actual)
     VALUES ($1,$2,$3,1,'2026-10-26','ship',1)`, [A.tenantId, run, sc])), /row-level security/);
  assert.equal((await q("SELECT status FROM execution_movements WHERE id = $1", [a.id]))[0].status, "posted");
});
