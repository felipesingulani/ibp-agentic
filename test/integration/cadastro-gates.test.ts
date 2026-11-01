// T-BIZ-CAD-GATES M2/M3 (EN-09/EN-10): FIL-RAO e CT-104 bloqueiam o A4 sem INSERT;
// FD-06 só avisa (202); GET /gates devolve os mesmos items do 409.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { createApp } from "../../src/http/app.js";
import { makePool } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import { ownerCreateScenario, setupTwoTenants } from "./helpers.js";

const pool = makePool(env.databaseUrl);
const owner = new pg.Client({ connectionString: env.migrationDatabaseUrl });
type Who = { tenantId: string; adminUserId: string };
let A: Who, B: Who;
let base = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

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
const runs = (tenantId: string, scenarioId: string) => owner.query(
  "SELECT count(*)::int AS n FROM a4_runs WHERE tenant_id = $1 AND scenario_id = $2", [tenantId, scenarioId]).then((r) => r.rows[0].n as number);
const decisions = (scenarioId: string) => owner.query(
  "SELECT count(*)::int AS n FROM decision_events WHERE scenario_id = $1", [scenarioId]).then((r) => r.rows[0].n as number);

/** Pronto para o A4 (readiness ≠ block) com custo e preço — o gate do cenário é que decide. */
async function ready(who: Who) {
  const node = (code: string) => ok(who, "POST", "/api/nodes", { code, name: code, node_type: "outro" });
  const cd = await node("CD1");
  const l1 = await node("L1");
  await ok(who, "POST", "/api/node_capacity", { node_id: cd.stable_id, capacity_per_period: 100 });
  await ok(who, "POST", "/api/node_capacity", { node_id: l1.stable_id, capacity_per_period: 50 });
  await ok(who, "POST", "/api/routes", { code: "R1", origin_node_id: cd.stable_id, dest_node_id: l1.stable_id, cost_per_unit: 2, lead_time_days: 1 });
  const sku = await ok(who, "POST", "/api/skus", { code: "SKU-1", name: "SKU-1", unit_cost: 4, attrs: { unit_price: 9 } });
  await ok(who, "POST", "/api/policies", { kind: "Serviço", name: "svc", body: { min_fill_rate: 0.9 } });
  await ok(who, "POST", "/api/policies", { kind: "estoque", name: "est", body: {} });
  return { cd, l1, sku };
}

before(async () => {
  ({ a: A, b: B } = await setupTwoTenants());
  await owner.connect();
  server = createApp(pool).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server?.close(); await owner.end(); await pool.end(); });

test("M2 EN-09: FIL-RAO sem capacidade → 409 cadastro_gate_block e zero INSERT; M3 items = GET /gates", async () => {
  const net = await ready(A);
  const rao = await ok(A, "POST", "/api/nodes", { code: "FIL-RAO", name: "Filial Ribeirão", node_type: "filial" });
  const sc = await ownerCreateScenario(A.tenantId, "SC-RAO");
  const gap = await call(A, "POST", `/api/scenarios/${sc}/premise_cards`, {
    type: "Gap", status: "gap", links: { nodeId: rao.stable_id }, fields: { kind: "capacidade" },
  });
  assert.equal(gap.status, 201, JSON.stringify(gap.json));
  const before = await runs(A.tenantId, sc);
  const r = await call(A, "POST", "/api/a4-runs", { scenario_id: sc });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.error.code, "cadastro_gate_block");
  const hit = r.json.error.items.find((i: { code: string; rule: string }) => i.code === "FIL-RAO" && i.rule === "node_without_capacity");
  assert.ok(hit, JSON.stringify(r.json));
  assert.equal(hit.entity, "node");
  assert.equal(hit.stable_id, rao.stable_id);
  assert.equal(hit.severity, "block");
  assert.equal(hit.cta, `/cadastro/nodes/${rao.stable_id}`);
  assert.equal(await runs(A.tenantId, sc), before, "409 não cria run");
  const g = await call(A, "GET", `/api/scenarios/${sc}/gates`);
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.equal(g.json.state, "block");
  assert.deepEqual(g.json.items, r.json.error.items);
  assert.equal(g.json.seal.scenario.blocks, g.json.items.filter((i: { severity: string }) => i.severity === "block").length);
  assert.equal(g.json.seal.scenario.warns, g.json.items.filter((i: { severity: string }) => i.severity === "warn").length);
  assert.equal(typeof g.json.seal.global, "number");
  assert.ok(g.json.seal.global > 0);
  // decisão no mesmo bloqueio: 409 idêntico, sem evento
  const d = await call(A, "POST", "/api/decision-events", { scenario_id: sc, action: "escalate", why: "x".repeat(20) });
  assert.equal(d.status, 409, JSON.stringify(d.json));
  assert.deepEqual(d.json.error.items, r.json.error.items);
  assert.equal(await decisions(sc), 0);
  assert.equal(net.cd.code, "CD1");
});

test("M2 EN-10: CT-104 sem volume e sem vigência → 409; só FD-06 warn → 202 e decisão exige why ≥ 20", async () => {
  const net = await ready(B);
  await ok(B, "POST", "/api/sales_history", { node_id: net.cd.stable_id, sku_id: net.sku.stable_id, period: "2026-10", qty: 10 });
  const ct = await ok(B, "POST", "/api/supplier_contracts", { code: "CT-104", supplier_group: "Delta", sku_ids: [net.sku.stable_id] });
  const sc = await ownerCreateScenario(B.tenantId, "SC-CT");
  const before = await runs(B.tenantId, sc);
  const r = await call(B, "POST", "/api/a4-runs", { scenario_id: sc });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.error.code, "cadastro_gate_block");
  const rules = r.json.error.items.filter((i: { code: string }) => i.code === "CT-104").map((i: { rule: string }) => i.rule).sort();
  assert.deepEqual(rules, ["contract_out_of_validity", "contract_without_volume"]);
  assert.ok(r.json.error.items.every((i: { code: string }) => i.code === "CT-104"), JSON.stringify(r.json.error.items));
  assert.equal(r.json.error.items[0].cta, `/cadastro/supplier_contracts/${ct.stable_id}`);
  assert.equal(await runs(B.tenantId, sc), before);
  const g = await call(B, "GET", `/api/scenarios/${sc}/gates`);
  assert.equal(g.status, 200);
  assert.deepEqual(g.json.items, r.json.error.items);

  // Warn-only num tenant sem contrato ruim: escopo vazio → global, único item é FD-06.
  const { a: W } = await setupTwoTenants();
  const who = { tenantId: W.tenantId, adminUserId: W.adminUserId };
  await ready(who);
  await ok(who, "POST", "/api/finance_drivers", { mapping: { "FD-06": { driver: "Prazo de recebimento", regra: "", status: "draft" } } });
  const scW = await ownerCreateScenario(W.tenantId, "SC-FD");
  const w = await call(who, "POST", "/api/a4-runs", { scenario_id: scW });
  assert.equal(w.status, 202, JSON.stringify(w.json));
  assert.equal(await runs(W.tenantId, scW), 1);
  const gw = await call(who, "GET", `/api/scenarios/${scW}/gates`);
  assert.equal(gw.status, 200);
  assert.equal(gw.json.state, "warn");
  assert.deepEqual(gw.json.items.map((i: { code: string; rule: string; severity: string }) => [i.code, i.rule, i.severity]),
    [["FD-06", "finance_driver_draft", "warn"]]);
  const short = await call(who, "POST", "/api/decision-events", { scenario_id: scW, action: "escalate", why: "curto" });
  assert.equal(short.status, 400, JSON.stringify(short.json));
  assert.equal(short.json.error, "invalid_input");
  assert.deepEqual(short.json.details, { field: "why", rule: "gate_warn_min_20" });
  assert.equal(await decisions(scW), 0);
  const long = await call(who, "POST", "/api/decision-events", { scenario_id: scW, action: "escalate", why: "x".repeat(20) });
  assert.equal(long.status, 201, JSON.stringify(long.json));
  assert.equal(await decisions(scW), 1);
});

test("ordem do POST /api/a4-runs: zod → preflight 503 → cenário 400 → readiness 409 → gates; GET 404", async () => {
  const bad = await call(A, "POST", "/api/a4-runs", { scenario_id: "nope" });
  assert.equal(bad.status, 400);
  const saved = process.env.A4_SOLVER_URL;
  process.env.A4_SOLVER_URL = "http://127.0.0.1:9";
  try {
    const sc = await ownerCreateScenario(A.tenantId, "SC-PRE");
    const pre = await call(A, "POST", "/api/a4-runs", { scenario_id: sc });
    assert.equal(pre.status, 503, JSON.stringify(pre.json));
    assert.deepEqual(pre.json, { error: { code: "solver_unavailable" } });
    assert.equal(await runs(A.tenantId, sc), 0);
  } finally {
    if (saved === undefined) delete process.env.A4_SOLVER_URL; else process.env.A4_SOLVER_URL = saved;
  }
  const empty = await ownerCreateScenario(B.tenantId, "SC-EMPTY-G");
  // B já tem cadastro pronto (teste anterior). Tenant novo para readiness block.
  const { a: C } = await setupTwoTenants();
  const who = { tenantId: C.tenantId, adminUserId: C.adminUserId };
  const scE = await ownerCreateScenario(C.tenantId, "SC-NOTREADY");
  const nr = await call(who, "POST", "/api/a4-runs", { scenario_id: scE });
  assert.equal(nr.status, 409, JSON.stringify(nr.json));
  assert.equal(nr.json.error, "a4_not_ready");
  assert.equal((await call(A, "GET", `/api/scenarios/${empty}/gates`)).status, 404);
  assert.equal((await call(A, "GET", "/api/scenarios/not-a-uuid/gates")).status, 404);
});
