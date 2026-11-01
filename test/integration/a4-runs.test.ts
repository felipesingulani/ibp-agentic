// W1c E2E: POST/GET /api/a4-runs — run real (CBC em processo filho) num fixture pequeno; saída no schema do contrato.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp } from "../../src/http/app.js";
import { makePool, withTenant } from "../../src/db/pool.js";
import pg from "pg";
import { loadSnapshot } from "../../src/a4/run.js";
import { paramsFrom } from "../../src/a4/model.js";
import { env } from "../../src/config/env.js";
import { ownerCreateScenario, setupTwoTenants } from "./helpers.js";
import { validateSummary } from "../support/schemas.js";

const pool = makePool(env.databaseUrl);
let base = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
type Who = { tenantId: string; adminUserId: string };
let A: Who, B: Who;

async function call(who: Who, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-tenant-id": who.tenantId, "x-user-id": who.adminUserId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
async function ok(who: Who, method: string, path: string, body?: unknown) {
  const r = await call(who, method, path, body);
  assert.ok(r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json?.data;
}
async function waitDone(who: Who, id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await call(who, "GET", `/api/a4-runs/${id}`);
    assert.equal(r.status, 200);
    if (r.json.data.status === "done" || r.json.data.status === "failed") return r.json.data;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("run não terminou");
}

/** 2 CDs (cap 100 + 50), 2 lojas sem capacidade, 2 SKUs; demanda 160 > 150. */
async function seedNetwork(who: Who, demandScale = 1) {
  const node = (code: string) => ok(who, "POST", "/api/nodes", { code, name: code, node_type: "outro" });
  const [cd1, cd2, l1, l2] = [await node("CD1"), await node("CD2"), await node("L1"), await node("L2")];
  await ok(who, "POST", "/api/node_capacity", { node_id: cd1.stable_id, capacity_per_period: 100 });
  await ok(who, "POST", "/api/node_capacity", { node_id: cd2.stable_id, capacity_per_period: 50 });
  const route = (code: string, o: { stable_id: string }, d: { stable_id: string }, cost: number, lt: number) =>
    ok(who, "POST", "/api/routes", { code, origin_node_id: o.stable_id, dest_node_id: d.stable_id, cost_per_unit: cost, lead_time_days: lt });
  await route("R1", cd1, l1, 2, 1); await route("R2", cd2, l1, 5, 4); await route("R3", cd1, l2, 3, 1); await route("R4", cd2, l2, 1, 1);
  const s1 = await ok(who, "POST", "/api/skus", { code: "S1", name: "S1", unit_cost: 1, attrs: { unit_price: 2 } });
  const s2 = await ok(who, "POST", "/api/skus", { code: "S2", name: "S2", unit_cost: 1, attrs: { unit_price: 2 } });
  await ok(who, "POST", "/api/policies", { kind: "Serviço", name: "svc", body: { min_fill_rate: 0.98, max_lead_time_days: 3 } });
  await ok(who, "POST", "/api/policies", { kind: "estoque", name: "est", body: {} });
  const rows = [[l1, s1, 60], [l1, s2, 30], [l2, s1, 50], [l2, s2, 20]].map(([n, k, q]) => ({
    node_id: (n as { stable_id: string }).stable_id, sku_id: (k as { stable_id: string }).stable_id, period: "2026-10", qty: (q as number) * demandScale }));
  await ok(who, "POST", "/api/sales_history", { rows: [...rows, { ...rows[0], period: "2026-09", qty: 9999 }] }); // período antigo ignorado
  return { cd1, cd2, l1, l2, s1, s2 };
}

before(async () => {
  ({ a: A, b: B } = await setupTwoTenants());
  server = createApp(pool).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server.close(); await pool.end(); });

test("readiness block → 409 a4_not_ready; unknown/cross-tenant scenario → 400", async () => {
  const sc = await ownerCreateScenario(A.tenantId, "SC-EMPTY");
  const r = await call(A, "POST", "/api/a4-runs", { scenario_id: sc });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.error, "a4_not_ready");
  const x = await call(B, "POST", "/api/a4-runs", { scenario_id: sc });
  assert.equal(x.status, 400, JSON.stringify(x.json));
  assert.equal((await call(A, "POST", "/api/a4-runs", { scenario_id: "nope" })).status, 400);
});

test("happy A4 run (real CBC): queued → done/partial, top-3 reasons with capacidade, countsByKind, schema-valid, RLS", async () => {
  const net = await seedNetwork(A);
  const sc = await ownerCreateScenario(A.tenantId, "SC-1");
  const created = await call(A, "POST", "/api/a4-runs", { scenario_id: sc });
  assert.equal(created.status, 202, JSON.stringify(created.json));
  assert.ok(["queued", "running"].includes(created.json.data.status));
  assert.equal(created.json.data.summary.scenarioVersion, 1);
  const run = await waitDone(A, created.json.data.id);
  assert.equal(run.status, "done", JSON.stringify(run.error));
  assert.equal(run.outcome, "partial");
  assert.ok(validateSummary(run.summary), JSON.stringify(validateSummary.errors));
  const { reasons, countsByKind } = run.summary;
  assert.ok(reasons.length >= 1 && reasons.length <= 3);
  assert.deepEqual(reasons.map((r: { rank: number }) => r.rank), reasons.map((_: unknown, i: number) => i + 1));
  assert.equal(reasons[0].kind, "capacidade");
  assert.equal(reasons[0].severity, "block");
  assert.ok([net.l1.stable_id, net.l2.stable_id].includes(reasons[0].refs.nodeId));
  assert.equal(reasons[0].refs.period, "2026-10");
  assert.ok(countsByKind.capacidade >= 1);
  assert.ok(!JSON.stringify(run.summary).includes("tancagem"));
  assert.equal(run.plan.totals.demand, 160);
  assert.ok(Math.abs(run.plan.totals.unmet - 10) < 1e-6);
  // RLS: B não vê o run de A; lista por cenário
  assert.equal((await call(B, "GET", `/api/a4-runs/${run.id}`)).status, 404);
  assert.equal((await ok(B, "GET", "/api/a4-runs")).length, 0);
  const list = await ok(A, "GET", `/api/a4-runs?scenario_id=${sc}`);
  assert.deepEqual(list.map((r: { id: string }) => r.id), [run.id]);
  // audit
  const audited = await ok(A, "GET", "/api/audit_log").catch(() => null);
  if (Array.isArray(audited)) assert.ok(audited.some((a: { entity: string }) => a.entity === "a4_runs"));
});

test("feasible run: enough capacity → done/feasible; Gap card legado 'tancagem' vira capacidade", async () => {
  const tb = await seedNetwork(B, 0.5); // demanda 80 ≤ 150
  // Gap em L1: o gate de cadastro exige capacidade no nó da premissa (AR-07). Capacidade local alta
  // não muda o veredito feasible nem a razão do Gap (utilização fica abaixo de 95%).
  await ok(B, "POST", "/api/node_capacity", { node_id: tb.l1.stable_id, capacity_per_period: 1000 });
  const sc = await ownerCreateScenario(B.tenantId, "SC-B");
  const gap = await call(B, "POST", "/api/premise_cards", { scenario_id: sc, card_id: "PC-1", type: "Gap", status: "gap",
    node_id: tb.l1.stable_id, fields: { kind: "tancagem", need: "tanque" }, source: "edit" });
  assert.equal(gap.status, 201, JSON.stringify(gap.json));
  const created = await call(B, "POST", "/api/a4-runs", { scenario_id: sc });
  assert.equal(created.status, 202, JSON.stringify(created.json));
  const run = await waitDone(B, created.json.data.id);
  assert.equal(run.status, "done", JSON.stringify(run.error));
  assert.equal(run.outcome, "feasible");
  assert.ok(validateSummary(run.summary), JSON.stringify(validateSummary.errors));
  assert.equal(run.summary.reasons[0].kind, "capacidade");
  assert.equal(run.summary.reasons[0].refs.nodeId, tb.l1.stable_id);
  assert.equal(run.summary.countsByKind.capacidade, 1);
  assert.ok(!JSON.stringify(run.summary).includes("tancagem"));
});

test("F-1: loadSnapshot lê tenant_settings.policy_kinds sob RLS → alias custom do tenant alimenta paramsFrom; outro tenant segue legado", async () => {
  const { a: C, b: D } = await setupTwoTenants();
  const owner = new pg.Client({ connectionString: env.migrationDatabaseUrl });
  await owner.connect();
  try {
    await owner.query("UPDATE tenant_settings SET policy_kinds = $2::jsonb WHERE tenant_id = $1", [C.tenantId,
      JSON.stringify({ working_capital: ["working_capital"], inventory: ["estoque"], service: ["fill_rate"] })]);
  } finally { await owner.end(); }
  for (const t of [C, D]) await ok(t, "POST", "/api/policies", { kind: "Fill Rate", name: "fr", body: { min_fill_rate: 0.93 } });
  const snap = (t: Who) => withTenant(pool, t.tenantId, (c) => loadSnapshot(c, { id: "00000000-0000-4000-8000-000000000000", version: 1, code: "X" }));
  const sc = await snap(C), sd = await snap(D);
  assert.deepEqual(sc.policyKinds?.service, ["fill_rate"]);
  assert.equal(paramsFrom(sc).minFillRate, 0.93);
  assert.ok(sd.policyKinds?.service.includes("servico") && !sd.policyKinds.service.includes("fill_rate"), "D = legado ({})");
  assert.equal(paramsFrom(sd).minFillRate, null);
});
