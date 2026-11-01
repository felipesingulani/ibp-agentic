// T-A7-LEVE — POST /api/a7/evaluate (a7.orch.v1): gate do roster, matriz dos vereditos, commit → DecisionEvent system,
// isolamento, provocations stub (sem A4), ajv. Fixtures via owner + API; leitura/escrita via app (RLS).
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { createApp } from "../../src/http/app.js";
import { makePool } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import { ownerCreateScenario, setupTwoTenants } from "./helpers.js";
import { validateA7Orch, validateDecisionEvent } from "../support/schemas.js";

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
async function ok(who: Who, method: string, path: string, body?: unknown) {
  const r = await call(who, method, path, body);
  assert.ok(r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json?.data;
}
const evaluate = (who: Who, body: unknown) => call(who, "POST", "/api/a7/evaluate", body);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Orch = any; // forma validada por ajv (a7-orchestration.schema.json) a cada chamada
async function evalOk(who: Who, scenarioId: string, commit?: boolean): Promise<Orch> {
  const r = await evaluate(who, commit === undefined ? { scenarioId } : { scenarioId, commit });
  const out: Orch = r.json;
  assert.equal(r.status, 200, JSON.stringify(out));
  assert.ok(validateA7Orch(out), JSON.stringify(validateA7Orch.errors));
  return out;
}
const q = (sql: string, p: unknown[] = []) => owner.query(sql, p).then((r) => r.rows);
const code = (p = "A7") => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const card = (tenantId: string, sc: string, type: string, fields: unknown, status = "ok", nodeId: string | null = null) =>
  q(`INSERT INTO premise_cards (tenant_id, scenario_id, card_id, type, fields, status, node_id, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'edit') RETURNING id`, [tenantId, sc, code("PC"), type, JSON.stringify(fields), status, nodeId]).then((r) => r[0].id as string);
async function run(tenantId: string, sc: string, status: string, o: { reasons?: unknown[]; ago?: number; version?: number } = {}) {
  return (await q(
    `INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status, reasons, counts_by_kind, plan, started_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,'{}',NULL, now() - make_interval(secs => $7), now() - make_interval(secs => $7))
     RETURNING id`, [tenantId, code("R"), sc, o.version ?? 1, status, JSON.stringify(o.reasons ?? []), o.ago ?? 0]))[0].id as string;
}
const counts = async (tenantId: string) => (await q(
  `SELECT (SELECT count(*) FROM decision_events WHERE tenant_id = $1)::int AS de, (SELECT count(*) FROM audit_log WHERE tenant_id = $1)::int AS al`, [tenantId]))[0];
const enableA7 = (who: Who) => ok(who, "PUT", "/api/tenant-settings", { agent_roster: { A7: { enabled: true, mode: "state_machine_only" } } });

async function tenants() {
  const t = await setupTwoTenants();
  const fin = (await q("INSERT INTO users (tenant_id, email, role) VALUES ($1, $2, 'finance') RETURNING id", [t.a.tenantId, `fin-${code()}@t.test`]))[0].id as string;
  return { A: { tenantId: t.a.tenantId, userId: t.a.adminUserId }, B: { tenantId: t.b.tenantId, userId: t.b.adminUserId },
    AFin: { tenantId: t.a.tenantId, userId: fin } };
}
/** readiness ok: 2 nós com capacidade, 1 rota, 1 SKU, política de capital de giro. */
async function seedReady(who: Who) {
  const node = (c: string) => ok(who, "POST", "/api/nodes", { code: c, name: c, node_type: "outro" });
  const [n1, n2] = [await node("CD1"), await node("L1")];
  for (const n of [n1, n2]) await ok(who, "POST", "/api/node_capacity", { node_id: n.stable_id, capacity_per_period: 100 });
  await ok(who, "POST", "/api/routes", { code: "R1", origin_node_id: n1.stable_id, dest_node_id: n2.stable_id, cost_per_unit: 2, lead_time_days: 1 });
  await ok(who, "POST", "/api/skus", { code: "S1", name: "S1" });
  await ok(who, "POST", "/api/policies", { kind: "capital de giro", name: "wc", body: {} });
  return { n1, n2 };
}

before(async () => {
  await owner.connect();
  server = createApp(pool).listen(0);
  await new Promise<void>((r) => (server as unknown as { once(e: string, f: () => void): void }).once("listening", r));
  base = `http://127.0.0.1:${((server as unknown as { address(): AddressInfo }).address()).port}`;
});
after(async () => { server.close(); await owner.end(); await pool.end(); });

test("M1: 400 validation_failed · 404 inexistente/outro tenant · 409 a7_disabled (commit true|false) · 409 arquivado", async () => {
  const { A, B } = await tenants();
  const sc = await ownerCreateScenario(A.tenantId, code("SC"));
  for (const body of [{}, { scenarioId: "x" }, { scenarioId: sc, commit: "yes" }, { scenarioId: sc, extra: 1 }]) {
    const r = await evaluate(A, body);
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.json.error, "validation_failed");
  }
  assert.equal((await call(null, "POST", "/api/a7/evaluate", { scenarioId: sc })).status, 401, "sem x-tenant-id (middleware de tenant)");
  const before = await counts(A.tenantId);
  for (const commit of [false, true]) {
    const r = await evaluate(A, { scenarioId: sc, commit });
    assert.equal(r.status, 409); assert.equal(r.json.error, "a7_disabled"); // pack genérico: A7.enabled=false
  }
  assert.deepEqual(await counts(A.tenantId), before, "a7_disabled não escreve");
  await enableA7(A);
  assert.equal((await evaluate(A, { scenarioId: "00000000-0000-4000-8000-000000000000" })).json.error, "not_found");
  const rb = await evaluate(B, { scenarioId: sc, commit: true });
  assert.equal(rb.status, 404, "H1: cenário de outro tenant é invisível (RLS)"); assert.equal(rb.json.error, "not_found");
  await q("UPDATE scenarios SET status = 'archived' WHERE id = $1", [sc]);
  const ra = await evaluate(A, { scenarioId: sc });
  assert.equal(ra.status, 409); assert.equal(ra.json.error, "scenario_archived");
});

test("M2/H4: matriz await_inputs (readiness block · sem run · failed · versão antiga · stale) → escalate (partial · reasons · alçada) → auto", async () => {
  const { A, B } = await tenants();
  await enableA7(B);
  const scB = await ownerCreateScenario(B.tenantId, code("SC"));
  await run(B.tenantId, scB, "feasible", { ago: 5 });
  let o = await evalOk(B, scB);
  assert.deepEqual([o.verdict, o.package.options, o.basis.hasRun], ["await_inputs", ["fix_readiness"], true], "tenant vazio → readiness block");

  await enableA7(A); await seedReady(A);
  const sc = await ownerCreateScenario(A.tenantId, code("SC"));
  o = await evalOk(A, sc);
  assert.equal(o.schema, "a7.orch.v1"); assert.equal(o.scenarioId, sc); assert.equal(o.committedEventId, null);
  assert.deepEqual([o.verdict, o.basis.hasRun, o.basis.runStatus, o.package.options], ["await_inputs", false, null, ["rerun_a4_human"]]);
  await run(A.tenantId, sc, "failed", { ago: 50 });
  o = await evalOk(A, sc);
  assert.deepEqual([o.verdict, o.basis.runStatus], ["await_inputs", "failed"]);
  await run(A.tenantId, sc, "feasible", { ago: 40, version: 0 });
  assert.equal((await evalOk(A, sc)).verdict, "await_inputs", "run de versão antiga não conta");
  await card(A.tenantId, sc, "NovaFilial", { nome: "X" }); // premissa depois do run → stale
  await run(A.tenantId, sc, "feasible", { ago: 30, version: 1 });
  // o run (ago 30) é anterior ao card recém-criado → stale
  o = await evalOk(A, sc);
  assert.deepEqual([o.verdict, o.basis.runStale, o.package.options], ["await_inputs", true, ["rerun_a4_human"]]);

  await run(A.tenantId, sc, "partial", { ago: 0 });
  o = await evalOk(A, sc);
  assert.deepEqual([o.verdict, o.basis.runStatus, o.basis.runStale], ["escalate_human", "partial", false]);
  const rid = await run(A.tenantId, sc, "feasible", { ago: 0, reasons: [{ code: "svc_floor", severity: "warn", rank: 2, summary: "Serviço abaixo" }] });
  o = await evalOk(A, sc);
  assert.equal(o.verdict, "escalate_human");
  assert.ok(o.provocations.some((p: { agent: string; code: string; detail: { id: string } }) =>
    p.agent === "A5" && p.code === "policy_violation" && p.detail.id === `a4_run:${rid}:2`));
  await run(A.tenantId, sc, "feasible", { ago: 0, reasons: [{ code: "x", severity: "info", rank: 1, summary: "info" }] });
  o = await evalOk(A, sc);
  assert.deepEqual([o.verdict, o.basis.requiresFinance, o.basis.decisionState, o.package.options], ["auto_policy", false, "pending", []]);

  // alçada: Investimento sem política → no_policy (fail-closed) → requiresFinance → escalate + open_alcada
  const sc2 = await ownerCreateScenario(A.tenantId, code("SC"));
  await card(A.tenantId, sc2, "Investimento", { valor_mi: 5 });
  await new Promise((r) => setTimeout(r, 20));
  await run(A.tenantId, sc2, "feasible", { ago: 0 });
  o = await evalOk(A, sc2);
  assert.deepEqual([o.verdict, o.basis.requiresFinance, o.package.options], ["escalate_human", true, ["open_alcada"]]);
  assert.ok(o.provocations.some((p: { agent: string; code: string }) => p.agent === "A5" && p.code === "alcada_required"));
  assert.ok(!o.provocations.some((p: { agent: string }) => p.agent === "A4"), "A4 nunca provoca");
});

test("M3: commit=false não escreve; auto+commit → approve system (userId null) + audit c/ pacote; reavaliar/commit → 409 decision_closed", async () => {
  const { A } = await tenants();
  await enableA7(A); await seedReady(A);
  const sc = await ownerCreateScenario(A.tenantId, code("SC"));
  const rid = await run(A.tenantId, sc, "feasible", { ago: 0 });
  const c0 = await counts(A.tenantId);
  assert.equal((await evalOk(A, sc)).verdict, "auto_policy");
  assert.equal((await evalOk(A, sc, false)).committedEventId, null);
  assert.deepEqual(await counts(A.tenantId), c0, "commit=false: zero escrita (decision_events/audit_log)");

  const o = await evalOk(A, sc, true);
  assert.equal(o.verdict, "auto_policy"); assert.ok(o.committedEventId);
  const ev = (await q("SELECT * FROM decision_events WHERE id = $1", [o.committedEventId]))[0];
  assert.deepEqual([ev.action, ev.actor_role, ev.actor_user_id, ev.run_id, ev.scenario_id], ["approve", "system", null, rid, sc]);
  assert.match(ev.why, /^a7\.auto_policy\.v1:clean$/);
  const al = await q("SELECT actor_role, actor_user_id, payload FROM audit_log WHERE entity = 'decision_events' AND entity_id = $1", [o.committedEventId]);
  assert.equal(al.length, 1);
  assert.equal(al[0].actor_role, "system"); assert.equal(al[0].actor_user_id, null);
  assert.equal(al[0].payload.a7.schema, "a7.orch.v1"); assert.equal(al[0].payload.a7.verdict, "auto_policy");
  assert.equal(al[0].payload.a7.requestedBy, A.userId);
  assert.deepEqual(al[0].payload.a7.package, o.package);
  const list = await call(A, "GET", `/api/decision-events?scenarioId=${sc}`);
  assert.equal(list.status, 200);
  const de: Orch = list.json.data.find((e: { id: string }) => e.id === o.committedEventId);
  assert.ok(de, JSON.stringify(list.json));
  assert.equal(de.actor.role, "system"); assert.equal(de.actor.userId ?? null, null); assert.equal(de.action, "approve");
  assert.ok(validateDecisionEvent(de), JSON.stringify(validateDecisionEvent.errors));

  const c1 = await counts(A.tenantId);
  const again = await evaluate(A, { scenarioId: sc, commit: true });
  assert.equal(again.status, 409); assert.equal(again.json.error, "decision_closed");
  const peek = await evalOk(A, sc);
  assert.deepEqual([peek.verdict, peek.basis.decisionState], ["escalate_human", "approved"], "fechado: fail-closed, sem auto");
  assert.deepEqual(await counts(A.tenantId), c1);
});

test("M3: escalate+commit → finance (alçada) | domain_owner (partial); 2º commit → 409 already_escalated; await+commit → 400; finance humano aprova", async () => {
  const { A, AFin } = await tenants();
  await enableA7(A); await seedReady(A);
  const sc = await ownerCreateScenario(A.tenantId, code("SC"));
  await card(A.tenantId, sc, "Investimento", { valor_mi: 5 });
  await new Promise((r) => setTimeout(r, 20));
  const rid = await run(A.tenantId, sc, "feasible", { ago: 0 });
  const o = await evalOk(A, sc, true);
  assert.equal(o.verdict, "escalate_human");
  const ev = (await q("SELECT * FROM decision_events WHERE id = $1", [o.committedEventId]))[0];
  assert.deepEqual([ev.action, ev.actor_role, ev.actor_user_id, ev.run_id], ["escalate", "system", null, rid]);
  assert.equal(ev.why, "a7.escalate.v1:requires_finance");
  const al = (await q("SELECT payload FROM audit_log WHERE entity = 'decision_events' AND entity_id = $1", [o.committedEventId]))[0].payload;
  assert.equal(al.escalateTo, "finance"); assert.deepEqual(al.a7.package.options, ["open_alcada"]);
  const again = await evaluate(A, { scenarioId: sc, commit: true });
  assert.equal(again.status, 409); assert.equal(again.json.error, "already_escalated");
  const peek = await evalOk(A, sc);
  assert.deepEqual([peek.verdict, peek.basis.decisionState, peek.package.options], ["escalate_human", "escalated", ["open_alcada", "wait"]]);
  const fin = await call(AFin, "POST", "/api/decision-events", { scenario_id: sc, run_id: rid, action: "approve", why: "Aprovo: investimento dentro do previsto pela diretoria." });
  assert.equal(fin.status, 201, JSON.stringify(fin.json));

  const sc2 = await ownerCreateScenario(A.tenantId, code("SC"));
  await run(A.tenantId, sc2, "partial", { ago: 0 });
  const o2 = await evalOk(A, sc2, true);
  const al2 = (await q("SELECT payload FROM audit_log WHERE entity = 'decision_events' AND entity_id = $1", [o2.committedEventId]))[0].payload;
  assert.equal(al2.escalateTo, "domain_owner");

  const sc3 = await ownerCreateScenario(A.tenantId, code("SC"));
  const c0 = await counts(A.tenantId);
  const r3 = await evaluate(A, { scenarioId: sc3, commit: true });
  assert.equal(r3.status, 400); assert.equal(r3.json.error, "commit_not_allowed");
  assert.deepEqual(await counts(A.tenantId), c0, "await + commit não escreve");
});

test("H2: provocations A1 (curva v1 gap) + A2/A6 (Gap card) com opção edit_premises; sem A4; dedupe", async () => {
  const { A } = await tenants();
  await enableA7(A); const { n1 } = await seedReady(A);
  const sc = await ownerCreateScenario(A.tenantId, code("SC"));
  const cv = await card(A.tenantId, sc, "CurvaDemanda", { schema: "a1.curva.v1", gapCode: "hist_insufficient" }, "gap");
  const gp = await card(A.tenantId, sc, "Gap", { motivo: "capacidade" }, "gap", n1.stable_id);
  await new Promise((r) => setTimeout(r, 20));
  await run(A.tenantId, sc, "feasible", { ago: 0 });
  const o = await evalOk(A, sc);
  const keys = o.provocations.map((p: { agent: string; code: string; detail: { id: string | null } }) => `${p.agent}:${p.code}:${p.detail.id}`);
  assert.ok(keys.includes(`A1:hist_gap:${cv}`), keys.join(","));
  assert.ok(keys.some((k: string) => k.startsWith("A2:supply_gap:")), keys.join(","));
  assert.ok(keys.some((k: string) => k.startsWith("A6:pulse_exception:")), keys.join(","));
  assert.ok(!keys.some((k: string) => k.startsWith("A4")));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(o.package.options.includes("edit_premises"));
  assert.deepEqual(o.package.premises.slice(0, 2).map((p: { id: string }) => p.id), [gp, cv], "Gap → CurvaDemanda primeiro");
});
