// T-BIZ-WC-V0 + T-BIZ-MARGIN-STUB — EN-06 (visões/pulse) + EN-12 (audit pack) + GET finance + RLS.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { createApp } from "../../src/http/app.js";
import { makePool } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import { ownerCreateScenario, setupTwoTenants } from "./helpers.js";
import { validateScenarioFinance } from "../support/schemas.js";

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
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}
const get = (who: Who | null, path: string) => call(who, "GET", path);
const q = (sql: string, p: unknown[] = []) => owner.query(sql, p).then((r) => r.rows);
const code = () => `SF-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function tenants() {
  const t = await setupTwoTenants();
  return { A: { tenantId: t.a.tenantId, userId: t.a.adminUserId }, B: { tenantId: t.b.tenantId, userId: t.b.adminUserId } };
}

before(async () => {
  await owner.connect();
  server = createApp(pool).listen(0);
  await new Promise<void>((r) => (server as unknown as { once(e: string, f: () => void): void }).once("listening", r));
  base = `http://127.0.0.1:${((server as unknown as { address(): AddressInfo }).address()).port}`;
});
after(async () => { server.close(); await owner.end(); await pool.end(); });

test("EN-06: visões finance e pulse saem de not_computed_v0; sem run → no_plan; GET finance bate a conta", async () => {
  const { A, B } = await tenants();
  const empty = await get(A, "/api/pulse/summary");
  assert.equal(empty.json.data.kpis.find((k: { key: string }) => k.key === "wc").nullReason, "no_plan");

  const sc = await ownerCreateScenario(A.tenantId, code());
  const bare = await get(A, `/api/scenarios/${sc}/finance`);
  assert.equal(bare.status, 200, JSON.stringify(bare.json));
  assert.equal(bare.json.data.runId, null);
  assert.equal(bare.json.data.revenue.nullReason, "no_plan");
  assert.ok(validateScenarioFinance(bare.json.data), JSON.stringify(validateScenarioFinance.errors));
  assert.equal((await get(B, `/api/scenarios/${sc}/finance`)).status, 404);
  assert.equal((await get(A, `/api/scenarios/${sc}/finance?run_id=nope`)).status, 400);

  await q("UPDATE tenant_settings SET currency = 'BRL', uom = 't' WHERE tenant_id = $1", [A.tenantId]);
  const node = (await q("INSERT INTO nodes (tenant_id, code, name, node_type) VALUES ($1,'CD1','CD','cd') RETURNING stable_id", [A.tenantId]))[0].stable_id as string;
  await q("INSERT INTO node_capacity (tenant_id, node_id, capacity_t_month) VALUES ($1,$2,1000)", [A.tenantId, node]);
  const sku = (await q(
    "INSERT INTO skus (tenant_id, code, name, unit_cost, attrs) VALUES ($1,'SKU-1','S',900,$2) RETURNING stable_id",
    [A.tenantId, JSON.stringify({ unit_price: 1500 })],
  ))[0].stable_id as string;
  await q("INSERT INTO policies (tenant_id, kind, name, body) VALUES ($1,'inventory','POL-DSI',$2)",
    [A.tenantId, JSON.stringify({ dsi_days: 45 })]);
  const plan = {
    period: "2026-09", objective: 0,
    local: [{ nodeId: node, skuId: sku, qty: 1000 }], flows: [],
    totals: { demand: 1000, served: 1000, fillRate: 1 },
  };
  const rid = (await q(
    `INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status, plan, finished_at)
     VALUES ($1,$2,$3,1,'feasible',$4, now()) RETURNING id`,
    [A.tenantId, code(), sc, JSON.stringify(plan)]))[0].id as string;

  const fin = await get(A, `/api/scenarios/${sc}/finance`);
  assert.equal(fin.status, 200, JSON.stringify(fin.json));
  assert.ok(validateScenarioFinance(fin.json.data), JSON.stringify(validateScenarioFinance.errors));
  assert.equal(fin.json.data.runId, rid);
  assert.equal(fin.json.data.financeVersion, "sf.v0");
  assert.deepEqual(fin.json.data.formulaVersions, { wc: "wc_days_v0", mc: "mc_stub_v0" });
  assert.equal(fin.json.data.wc.total.value, 2.7);
  assert.equal(fin.json.data.revenue.value, 1.5);
  assert.equal(fin.json.data.mc.value, 0.6);
  assert.equal(fin.json.data.deltaMc.nullReason, "no_baseline");
  assert.equal((await get(A, `/api/scenarios/${sc}/finance?run_id=${rid}`)).json.data.wc.total.value, 2.7);
  assert.equal((await get(A, `/api/scenarios/${sc}/finance?run_id=00000000-0000-4000-8000-000000000000`)).status, 404);

  const pulse = (await get(A, "/api/pulse/summary")).json.data;
  const wc = pulse.kpis.find((k: { key: string }) => k.key === "wc");
  assert.equal(wc.value, 2.7);
  assert.equal(wc.nullReason, null);
  assert.notEqual(wc.nullReason, "not_computed_v0");
  const lens = (await get(A, "/api/visoes/finance")).json.data;
  assert.equal(lens.cards.find((k: { key: string }) => k.key === "wc").value, wc.value);
  assert.equal(lens.cards.find((k: { key: string }) => k.key === "wc").nullReason, null);
});

test("baseline aprovado sem DSI propaga no_policy no ΔWC; sem approve o delta é no_baseline", async () => {
  const { A } = await tenants();
  const sku = (await q(
    "INSERT INTO skus (tenant_id, code, name, unit_cost, attrs) VALUES ($1,'SKU-B','S',900,$2) RETURNING stable_id",
    [A.tenantId, JSON.stringify({ unit_price: 1500 })],
  ))[0].stable_id as string;
  const plan = (qty: number, period = "2026-09") => ({
    period, objective: 0, local: [{ skuId: sku, qty }], flows: [],
  });
  const current = await ownerCreateScenario(A.tenantId, code());
  await q(
    `INSERT INTO premise_cards (tenant_id, scenario_id, card_id, type, fields, status, source)
     VALUES ($1,$2,'PC-DSI','CurvaDemanda',$3,'ok','edit')`,
    [A.tenantId, current, JSON.stringify({ dsi_days: 45 })],
  );
  const currentRun = (await q(
    `INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status, plan, finished_at)
     VALUES ($1,$2,$3,1,'feasible',$4, now()) RETURNING id`,
    [A.tenantId, code(), current, JSON.stringify(plan(1000))],
  ))[0].id as string;

  const before = await get(A, `/api/scenarios/${current}/finance`);
  assert.equal(before.status, 200, JSON.stringify(before.json));
  assert.ok(validateScenarioFinance(before.json.data), JSON.stringify(validateScenarioFinance.errors));
  assert.equal(before.json.data.mc.value, 0.6);
  assert.equal(before.json.data.wc.total.value, 2.7);
  assert.equal(before.json.data.deltaMc.nullReason, "no_baseline");
  assert.equal(before.json.data.deltaWc.nullReason, "no_baseline");
  assert.deepEqual(before.json.data.periodDays, { value: 30, source: "period" });

  const badRun = (await q(
    `INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status, plan, finished_at)
     VALUES ($1,$2,$3,1,'feasible',$4, now()) RETURNING id`,
    [A.tenantId, code(), current, JSON.stringify(plan(1000, "2026-13"))],
  ))[0].id as string;
  const bad = await get(A, `/api/scenarios/${current}/finance?run_id=${badRun}`);
  assert.equal(bad.status, 200, JSON.stringify(bad.json));
  assert.ok(validateScenarioFinance(bad.json.data), JSON.stringify(validateScenarioFinance.errors));
  assert.deepEqual(bad.json.data.periodDays, { value: 30, source: "default_pack" });

  const baseSc = await ownerCreateScenario(A.tenantId, code());
  const baseRun = (await q(
    `INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status, plan, finished_at)
     VALUES ($1,$2,$3,1,'feasible',$4, now()) RETURNING id`,
    [A.tenantId, code(), baseSc, JSON.stringify(plan(500))],
  ))[0].id as string;
  await q(
    `INSERT INTO decision_events (tenant_id, scenario_id, scenario_version, run_id, action, why, actor_role)
     VALUES ($1,$2,1,$3,'approve','aprovo o baseline sem DSI','domain_owner')`,
    [A.tenantId, baseSc, baseRun],
  );
  const baseFin = await get(A, `/api/scenarios/${baseSc}/finance`);
  assert.equal(baseFin.status, 200, JSON.stringify(baseFin.json));
  assert.equal(baseFin.json.data.mc.value, 0.3);
  assert.equal(baseFin.json.data.wc.total.value, null);
  assert.equal(baseFin.json.data.wc.total.nullReason, "no_policy");

  const after = await get(A, `/api/scenarios/${current}/finance?run_id=${currentRun}`);
  assert.equal(after.status, 200, JSON.stringify(after.json));
  assert.ok(validateScenarioFinance(after.json.data), JSON.stringify(validateScenarioFinance.errors));
  assert.equal(after.json.data.deltaMc.value, 0.3);
  assert.equal(after.json.data.deltaMc.nullReason, undefined);
  assert.equal(after.json.data.deltaWc.value, null);
  assert.equal(after.json.data.deltaWc.nullReason, "no_policy");
  assert.notEqual(after.json.data.deltaWc.nullReason, "no_baseline");
  assert.equal(after.json.data.paybackWithWcMonths.nullReason, "no_policy");
});

test("EN-12: approve grava audit_log.payload.pack; warn de cadastro exige why ≥ 20", async () => {
  const { A } = await tenants();
  const node = (await q("INSERT INTO nodes (tenant_id, code, name, node_type) VALUES ($1,'N1','N','cd') RETURNING stable_id", [A.tenantId]))[0].stable_id as string;
  await q("INSERT INTO node_capacity (tenant_id, node_id, capacity_t_month) VALUES ($1,$2,10)", [A.tenantId, node]);
  const sku = (await q(
    "INSERT INTO skus (tenant_id, code, name, unit_cost, attrs) VALUES ($1,'K1','K',1,$2) RETURNING stable_id",
    [A.tenantId, JSON.stringify({ unit_price: 3 })],
  ))[0].stable_id as string;
  const sc = await ownerCreateScenario(A.tenantId, code());
  const plan = { period: "2026-09", objective: 0, local: [{ nodeId: node, skuId: sku, qty: 10000 }], flows: [] };
  const rid = (await q(
    `INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status, plan, finished_at)
     VALUES ($1,$2,$3,1,'feasible',$4, now()) RETURNING id`,
    [A.tenantId, code(), sc, JSON.stringify(plan)]))[0].id as string;

  await q("INSERT INTO finance_drivers (tenant_id, mapping) VALUES ($1,$2)",
    [A.tenantId, JSON.stringify([{ code: "FD-06", status: "draft", regra: "volume" }])]);
  const short = await call(A, "POST", "/api/decision-events", { scenario_id: sc, run_id: rid, action: "approve", why: "curto" });
  assert.equal(short.status, 400, JSON.stringify(short.json));
  assert.equal(short.json.details.rule, "gate_warn_min_20");

  const why = "Aprovo mesmo com FD-06 em rascunho; o número de margem foi revisado.";
  const ok = await call(A, "POST", "/api/decision-events", { scenario_id: sc, run_id: rid, action: "approve", why });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const au = (await q("SELECT payload FROM audit_log WHERE entity = 'decision_events' AND entity_id = $1", [ok.json.data.id]))[0].payload;
  assert.equal(au.pack.financeVersion, "sf.v0");
  assert.deepEqual(au.pack.formulaVersions, { wc: "wc_days_v0", mc: "mc_stub_v0" });
  assert.equal(au.pack.runId, rid);
  assert.equal(au.pack.gates.state, "warn");
  assert.ok("deltaWc" in au.pack && "deltaMc" in au.pack && "paybackMonths" in au.pack && "paybackWithWcMonths" in au.pack);
  assert.equal(au.pack.capexMi.value, null);
});
