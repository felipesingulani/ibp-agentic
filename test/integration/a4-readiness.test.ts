// W1b E2E: GET /api/a4-readiness — tenant vazio vs amostra, capacidade via node_capacity corrente, flag supply externo, RLS.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp } from "../../src/http/app.js";
import { makePool } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import { ownerCreateScenario, setupTwoTenants } from "./helpers.js";

const pool = makePool(env.databaseUrl);
let base = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let A: { tenantId: string; adminUserId: string };
let B: { tenantId: string; adminUserId: string };

async function call(who: typeof A, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-tenant-id": who.tenantId, "x-user-id": who.adminUserId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const capBy = (r: { items: { key: string; by: string[] }[] }) => r.items.find((i) => i.key === "node_capacity")!.by;
async function readiness(who: typeof A) {
  const r = await call(who, "GET", "/api/a4-readiness");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const d = r.json.data;
  return { ...d, s: Object.fromEntries(d.items.map((i: { key: string; status: string }) => [i.key, i.status])) };
}

before(async () => {
  ({ a: A, b: B } = await setupTwoTenants());
  server = createApp(pool).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server.close(); await pool.end(); });

test("empty tenant: falta ×4 (coach B: + sku), contract n/a, 0%", async () => {
  const r = await readiness(A);
  assert.deepEqual(r.s, { node_capacity: "falta", sku: "falta", route: "falta", supplier_contract: "n/a", policy: "falta" });
  assert.deepEqual(r.items.map((i: { key: string }) => i.key), ["node_capacity", "sku", "route", "supplier_contract", "policy"]);
  assert.deepEqual([r.met, r.need, r.pct, r.state], [0, 4, 0, "block"]);
  assert.equal(r.scope.supply_external_in_scope, false);
  for (const i of r.items) { assert.equal(typeof i.label, "string"); assert.equal(typeof i.required, "boolean"); assert.ok(Array.isArray(i.by)); }
});

test("sample seed → ok; capacity only via current node_capacity; flag toggles contract; tenant B unaffected", async () => {
  const n1 = (await call(A, "POST", "/api/nodes", { code: "N1", name: "Node 1", node_type: "outro" })).json.data;
  // coach B (v0.3.10): ≥1 SKU corrente é item exigido do A4
  const s0 = await call(A, "POST", "/api/skus", { code: "S0", name: "Item 0" });
  assert.equal(s0.status, 201, JSON.stringify(s0.json));
  const n2 = (await call(A, "POST", "/api/nodes", { code: "N2", name: "Node 2", node_type: "outro" })).json.data;
  await call(A, "POST", "/api/policies", { kind: "estoque", name: "e", body: {} });
  await call(A, "POST", "/api/routes", { code: "R1", origin_node_id: n1.stable_id, dest_node_id: n2.stable_id });
  // node sem capacidade: falta
  let r = await readiness(A);
  assert.deepEqual([r.s.policy, r.s.node_capacity, r.s.route], ["falta", "falta", "ok"]); // só estoque não basta
  await call(A, "POST", "/api/policies", { kind: "Serviço", name: "s", body: {} });
  const cap = await call(A, "POST", "/api/node_capacity", { node_id: n1.stable_id, capacity_per_period: 100 });
  assert.equal(cap.status, 201, JSON.stringify(cap.json));
  r = await readiness(A);
  assert.deepEqual(r.s, { node_capacity: "ok", sku: "ok", route: "ok", supplier_contract: "n/a", policy: "ok" });
  // N2 sem capacidade → warn (pronto c/ restrições)
  assert.deepEqual([r.met, r.need, r.pct, r.state], [4, 4, 100, "warn"]);
  assert.deepEqual(capBy(r), [n1.stable_id]);
  assert.deepEqual(r.warnings.map((w: { kind: string; by: string[] }) => [w.kind, w.by]), [["node_without_capacity", [n2.stable_id]]]);
  await call(A, "POST", "/api/node_capacity", { node_id: n2.stable_id, capacity_per_period: 10 });
  r = await readiness(A);
  assert.deepEqual([r.state, r.label, r.warnings.length], ["ok", "A4 pronto", 0]);

  // nova versão de capacidade = 0 → versão antiga (100) não conta
  const v2 = await call(A, "PATCH", `/api/node_capacity/${cap.json.data.id}`, { capacity_per_period: 0, why: "parada" });
  assert.equal(v2.status, 200, JSON.stringify(v2.json));
  r = await readiness(A);
  assert.deepEqual([r.s.node_capacity, capBy(r), r.state], ["ok", [n2.stable_id], "warn"]); // só N2 conta
  assert.deepEqual(r.warnings[0].by, [n1.stable_id]);
  const v3 = await call(A, "PATCH", `/api/node_capacity/${v2.json.data.id}`, { capacity_per_period: 80, why: "volta" });
  assert.equal((await readiness(A)).state, "ok");
  // nó aposentado não conta, mesmo com capacidade corrente (N2 ainda segura o item)
  assert.equal((await call(A, "DELETE", `/api/nodes/${n1.id}`, { why: "fechou" })).status, 204);
  r = await readiness(A);
  assert.deepEqual([r.s.node_capacity, capBy(r)], ["ok", [n2.stable_id]]);
  assert.equal((await call(A, "DELETE", `/api/nodes/${n2.id}`, { why: "fechou" })).status, 204);
  assert.equal((await readiness(A)).s.node_capacity, "falta");
  assert.ok(v3.status === 200);

  // supply externo no escopo → contrato exigido
  const n3 = (await call(A, "POST", "/api/nodes", { code: "N3", name: "Node 3", node_type: "outro" })).json.data;
  await call(A, "POST", "/api/node_capacity", { node_id: n3.stable_id, capacity_per_period: 5 });
  const put = await call(A, "PUT", "/api/tenant-settings", { supply_external_in_scope: true });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal(put.json.data.supply_external_in_scope, true);
  r = await readiness(A);
  assert.equal(r.s.supplier_contract, "falta");
  assert.deepEqual([r.met, r.need, r.pct, r.state], [4, 5, 80, "block"]);
  const sku = (await call(A, "POST", "/api/skus", { code: "S1", name: "Item" })).json.data;
  await call(A, "POST", "/api/supplier_contracts", { code: "C1", supplier_group: "G", sku_ids: [sku.stable_id] });
  r = await readiness(A);
  assert.deepEqual([r.s.supplier_contract, r.pct, r.state], ["ok", 100, "ok"]);
  // outro PUT sem o campo preserva o flag
  await call(A, "PUT", "/api/tenant-settings", { currency: "XYZ" });
  assert.equal((await readiness(A)).scope.supply_external_in_scope, true);

  // Gap card aberto → warn
  const scen = await ownerCreateScenario(A.tenantId, "SC-R");
  const gap = await call(A, "POST", "/api/premise_cards",
    { scenario_id: scen, card_id: "PC-G", type: "Gap", status: "gap", source: "edit", node_id: n3.stable_id });
  assert.equal(gap.status, 201, JSON.stringify(gap.json));
  r = await readiness(A);
  assert.deepEqual([r.state, r.warnings.map((w: { kind: string }) => w.kind)], ["warn", ["open_gap_card"]]);

  // isolamento: B continua vazio
  const b = await readiness(B);
  assert.deepEqual([b.pct, b.s.supplier_contract], [0, "n/a"]);
});
