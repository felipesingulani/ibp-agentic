// T-A4-SOLVER-WORKER E2E: POST /api/a4-runs com A4_SOLVER_URL set — preflight 503 {error:{code:"solver_unavailable"}} sem criar run;
// worker real (solver/worker.py) → run done/partial via HTTP; secret errado → run failed com error estável "solver_unavailable".
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, test } from "node:test";
import { createApp } from "../../src/http/app.js";
import { makePool } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import { ownerCreateScenario, setupTwoTenants } from "./helpers.js";
import { freePort, startWorker } from "../support/a4-worker.js";

const pool = makePool(env.databaseUrl);
const SECRET = "it-secret-" + Math.random().toString(36).slice(2);
let base = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let w: Awaited<ReturnType<typeof startWorker>>;
type Who = { tenantId: string; adminUserId: string };
let A: Who;

async function call(who: Who, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method, headers: { "content-type": "application/json", "x-tenant-id": who.tenantId, "x-user-id": who.adminUserId },
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
  for (let i = 0; i < 150; i++) {
    const r = await call(who, "GET", `/api/a4-runs/${id}`);
    if (r.json.data.status === "done" || r.json.data.status === "failed") return r.json.data;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("run não terminou");
}
/** 2 CDs (cap 100 + 50), 1 loja, 1 SKU; demanda 160 > 150 → partial. */
async function seed(who: Who) {
  const node = (code: string) => ok(who, "POST", "/api/nodes", { code, name: code, node_type: "outro" });
  const [cd1, cd2, l1] = [await node("CD1"), await node("CD2"), await node("L1")];
  await ok(who, "POST", "/api/node_capacity", { node_id: cd1.stable_id, capacity_per_period: 100 });
  await ok(who, "POST", "/api/node_capacity", { node_id: cd2.stable_id, capacity_per_period: 50 });
  await ok(who, "POST", "/api/routes", { code: "R1", origin_node_id: cd1.stable_id, dest_node_id: l1.stable_id, cost_per_unit: 2, lead_time_days: 1 });
  await ok(who, "POST", "/api/routes", { code: "R2", origin_node_id: cd2.stable_id, dest_node_id: l1.stable_id, cost_per_unit: 5, lead_time_days: 1 });
  const s1 = await ok(who, "POST", "/api/skus", { code: "S1", name: "S1", unit_cost: 1, attrs: { unit_price: 2 } });
  await ok(who, "POST", "/api/policies", { kind: "Serviço", name: "svc", body: { min_fill_rate: 0.98, max_lead_time_days: 3 } });
  await ok(who, "POST", "/api/policies", { kind: "estoque", name: "est", body: {} });
  await ok(who, "POST", "/api/sales_history", { rows: [{ node_id: l1.stable_id, sku_id: s1.stable_id, period: "2026-10", qty: 160 }] });
}

const saved = { u: process.env.A4_SOLVER_URL, s: process.env.A4_SOLVER_SECRET };
const restore = () => {
  if (saved.u === undefined) delete process.env.A4_SOLVER_URL; else process.env.A4_SOLVER_URL = saved.u;
  if (saved.s === undefined) delete process.env.A4_SOLVER_SECRET; else process.env.A4_SOLVER_SECRET = saved.s;
};
before(async () => {
  ({ a: A } = await setupTwoTenants());
  server = createApp(pool).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await seed(A);
  w = await startWorker(SECRET);
});
afterEach(restore);
after(async () => { restore(); server?.close(); await w?.stop(); await pool.end(); });

test("worker down (A4_SOLVER_URL inacessível) → 503 {error:{code:solver_unavailable}} e nenhum run criado", async () => {
  const sc = await ownerCreateScenario(A.tenantId, "SC-DOWN");
  process.env.A4_SOLVER_URL = `http://127.0.0.1:${await freePort()}`;
  process.env.A4_SOLVER_SECRET = SECRET;
  const r = await call(A, "POST", "/api/a4-runs", { scenario_id: sc });
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.deepEqual(r.json, { error: { code: "solver_unavailable" } });
  assert.equal((await ok(A, "GET", `/api/a4-runs?scenario_id=${sc}`)).length, 0, "sem INSERT órfão");
});

test("worker real via A4_SOLVER_URL → 202 + run done/partial (solve passou pelo HTTP do worker)", async () => {
  const sc = await ownerCreateScenario(A.tenantId, "SC-REMOTE");
  process.env.A4_SOLVER_URL = w.url;
  process.env.A4_SOLVER_SECRET = SECRET;
  const posts = (w.log().match(/POST \/v1\/solve/g) ?? []).length;
  const created = await call(A, "POST", "/api/a4-runs", { scenario_id: sc });
  assert.equal(created.status, 202, JSON.stringify(created.json));
  const run = await waitDone(A, created.json.data.id);
  assert.equal(run.status, "done", JSON.stringify(run.error));
  assert.equal(run.outcome, "partial");
  assert.ok(Math.abs(run.plan.totals.unmet - 10) < 1e-6);
  assert.equal((w.log().match(/POST \/v1\/solve/g) ?? []).length, posts + 1, "1 POST /v1/solve no worker");
});

test("health ok mas secret errado → 202 e run failed com error estável 'solver_unavailable' (sem URL/stack)", async () => {
  const sc = await ownerCreateScenario(A.tenantId, "SC-401");
  process.env.A4_SOLVER_URL = w.url;
  process.env.A4_SOLVER_SECRET = "wrong";
  const created = await call(A, "POST", "/api/a4-runs", { scenario_id: sc });
  assert.equal(created.status, 202, JSON.stringify(created.json));
  const run = await waitDone(A, created.json.data.id);
  assert.equal(run.status, "failed");
  assert.equal(run.error, "solver_unavailable");
});

test("A4_SOLVER_URL unset → comportamento W1c (202 + spawn local) intacto", async () => {
  const sc = await ownerCreateScenario(A.tenantId, "SC-LOCAL");
  delete process.env.A4_SOLVER_URL;
  const created = await call(A, "POST", "/api/a4-runs", { scenario_id: sc });
  assert.equal(created.status, 202, JSON.stringify(created.json));
  const run = await waitDone(A, created.json.data.id);
  assert.equal(run.status, "done", JSON.stringify(run.error));
  assert.equal(run.outcome, "partial");
});
