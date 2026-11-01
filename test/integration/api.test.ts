// E2E da API de cadastro: CRUD + versionamento + why + isolamento entre tenants via HTTP.
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

before(async () => {
  ({ a: A, b: B } = await setupTwoTenants());
  server = createApp(pool).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server.close(); await pool.end(); });

test("health", async () => {
  const r = await fetch(base + "/health").then((x) => x.json());
  assert.equal(r.ok, true);
});

test("full cadastro happy path for every entity", async () => {
  const n1 = await call(A, "POST", "/api/nodes", { code: "N1", name: "Node 1", node_type: "outro" });
  assert.equal(n1.status, 201, JSON.stringify(n1.json));
  const n2 = await call(A, "POST", "/api/nodes", { code: "N2", name: "Node 2", node_type: "outro" });
  const cap = await call(A, "POST", "/api/node_capacity", { node_id: n1.json.data.stable_id, capacity_t_month: 100 });
  assert.equal(cap.status, 201);
  const route = await call(A, "POST", "/api/routes",
    { code: "R1", origin_node_id: n1.json.data.id, dest_node_id: n2.json.data.id, lead_time_days: 2, windows: [] });
  assert.equal(route.status, 201, JSON.stringify(route.json));
  const sku = await call(A, "POST", "/api/skus", { code: "S1", name: "Item 1", family: "F1", unit_cost: 9.5 });
  assert.equal(sku.status, 201);
  const pol = await call(A, "POST", "/api/policies", { kind: "working_capital", name: "default", body: { max_days: 30 } });
  assert.equal(pol.status, 201, JSON.stringify(pol.json));
  assert.equal(pol.json.data.created_by, A.adminUserId);
  const ctr = await call(A, "POST", "/api/supplier_contracts",
    { code: "C1", supplier_group: "G1", sku_ids: [sku.json.data.id], valid_from: "2026-01-01", obligations: { min: 1 } });
  assert.equal(ctr.status, 201, JSON.stringify(ctr.json));
  const fin = await call(A, "POST", "/api/finance_drivers", { mapping: { volume: "cash" } });
  assert.equal(fin.status, 201);
  const sales = await call(A, "POST", "/api/sales_history", { rows: [
    { node_id: n1.json.data.id, sku_id: sku.json.data.id, period: "2026-09", qty: 10, revenue: 95 },
    { node_id: n1.json.data.id, sku_id: sku.json.data.id, period: "2026-10", qty: 12 },
  ] });
  assert.equal(sales.status, 201, JSON.stringify(sales.json));
  assert.equal(sales.json.count, 2);

  const list = await call(A, "GET", `/api/sales_history?node_id=${n1.json.data.id}&period_from=2026-10`);
  assert.equal(list.json.count, 1);

  // duplicate business key → 409
  assert.equal((await call(A, "POST", "/api/nodes", { code: "N1", name: "dup", node_type: "outro" })).status, 409);
  // tenant sem node_types configurado → qualquer texto não vazio (sem CHECK de vertical no SQL)
  assert.equal((await call(A, "POST", "/api/nodes", { code: "N9", name: "x", node_type: "qualquer-coisa" })).status, 201);
  assert.equal((await call(A, "POST", "/api/nodes", { code: "N10", name: "x", node_type: "  " })).status, 400);
});

test("W0.1 aliases: capacity_per_period / cost_per_unit in and out", async () => {
  const n1 = await call(A, "POST", "/api/nodes", { code: "AL1", name: "a", node_type: "site" });
  const n2 = await call(A, "POST", "/api/nodes", { code: "AL2", name: "b", node_type: "site" });
  const cap = await call(A, "POST", "/api/node_capacity", { node_id: n1.json.data.stable_id, capacity_per_period: 100 });
  assert.equal(cap.status, 201, JSON.stringify(cap.json));
  assert.equal(Number(cap.json.data.capacity_per_period), 100);
  assert.ok(!("capacity_t_month" in cap.json.data));
  const up = await call(A, "PATCH", `/api/node_capacity/${cap.json.data.id}`, { capacity_per_period: 150, why: "ajuste" });
  assert.equal(up.status, 200);
  assert.equal(Number(up.json.data.capacity_per_period), 150);
  // legacy column name still accepted on input
  const legacy = await call(A, "PATCH", `/api/node_capacity/${up.json.data.id}`, { capacity_t_month: 160, why: "legacy" });
  assert.equal(Number(legacy.json.data.capacity_per_period), 160);
  // conflicting alias + column → 400
  const bad = await call(A, "PATCH", `/api/node_capacity/${legacy.json.data.id}`,
    { capacity_per_period: 1, capacity_t_month: 2, why: "x" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "alias_conflict");
  const route = await call(A, "POST", "/api/routes",
    { code: "ALR", origin_node_id: n1.json.data.stable_id, dest_node_id: n2.json.data.stable_id, cost_per_unit: 3.5 });
  assert.equal(route.status, 201, JSON.stringify(route.json));
  assert.equal(Number(route.json.data.cost_per_unit), 3.5);
  assert.ok(!("cost_per_ton" in route.json.data));
  const ents = await call(A, "GET", "/api/entities");
  const nc = ents.json.data.find((e: { path: string }) => e.path === "node_capacity");
  assert.ok(nc.fields.includes("capacity_per_period") && !nc.fields.includes("capacity_t_month"));
});

test("W0.1 stable_id: new node version keeps identity; refs survive; refs use stable_id", async () => {
  const n = await call(A, "POST", "/api/nodes", { code: "ST1", name: "v1", node_type: "site" });
  const sid = n.json.data.stable_id;
  assert.equal(n.json.data.id, sid, "v1 id == stable_id");
  const n2 = await call(A, "POST", "/api/nodes", { code: "ST2", name: "dest", node_type: "site" });
  const cap = await call(A, "POST", "/api/node_capacity", { node_id: sid, capacity_per_period: 10 });
  const route = await call(A, "POST", "/api/routes", { code: "STR", origin_node_id: sid, dest_node_id: n2.json.data.stable_id });
  assert.equal(route.status, 201);

  const v2 = await call(A, "PATCH", `/api/nodes/${n.json.data.id}`, { name: "v2", why: "rename" });
  assert.equal(v2.status, 200);
  assert.equal(v2.json.data.version, 2);
  assert.equal(v2.json.data.stable_id, sid);
  assert.notEqual(v2.json.data.id, sid);

  // capacity/route still point at the (current) node identity
  const caps = await call(A, "GET", `/api/node_capacity?node_id=${sid}`);
  assert.equal(caps.json.count, 1);
  assert.equal(caps.json.data[0].id, cap.json.data.id);
  // new refs work with stable_id after the node moved to v2
  const cap2 = await call(A, "PATCH", `/api/node_capacity/${cap.json.data.id}`, { capacity_per_period: 11, why: "x" });
  assert.equal(cap2.status, 200);
  assert.equal(cap2.json.data.stable_id, cap.json.data.stable_id);
  // version-row id is NOT a valid reference
  const badRef = await call(A, "POST", "/api/node_capacity", { node_id: v2.json.data.id, capacity_per_period: 1 });
  assert.equal(badRef.status, 400);
  assert.equal(badRef.json.error, "invalid_reference");

  // history by any version id or by stable_id
  for (const id of [sid, v2.json.data.id]) {
    const h = await call(A, "GET", `/api/nodes/${id}/history`);
    assert.deepEqual(h.json.data.map((r: { version: number }) => r.version), [1, 2]);
  }
  const byStable = await call(A, "GET", `/api/nodes?stable_id=${sid}`);
  assert.equal(byStable.json.count, 1);
  assert.equal(byStable.json.data[0].version, 2);

  // retired node can't be referenced anymore
  assert.equal((await call(A, "DELETE", `/api/nodes/${v2.json.data.id}`, { why: "closed" })).status, 204);
  const afterRetire = await call(A, "POST", "/api/routes", { code: "STR2", origin_node_id: sid, dest_node_id: n2.json.data.stable_id });
  assert.equal(afterRetire.status, 400);
});

test("W0.1 node_type validated against tenant_settings.node_types when set", async () => {
  const put = await call(B, "PUT", "/api/tenant-settings", { node_types: ["hub", "site"] });
  assert.equal(put.status, 200);
  const bad = await call(B, "POST", "/api/nodes", { code: "VT1", name: "x", node_type: "planta" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "invalid_node_type");
  const ok = await call(B, "POST", "/api/nodes", { code: "VT1", name: "x", node_type: "hub" });
  assert.equal(ok.status, 201);
  assert.equal((await call(B, "PATCH", `/api/nodes/${ok.json.data.id}`, { node_type: "cd", why: "x" })).status, 400);
  assert.equal((await call(B, "PATCH", `/api/nodes/${ok.json.data.id}`, { node_type: "site", why: "x" })).status, 200);
  // policies.kind is free text (no vertical enum)
  const pol = await call(B, "POST", "/api/policies", { kind: "custom_kind", name: "p" });
  assert.equal(pol.status, 201);
  await call(B, "PUT", "/api/tenant-settings", { node_types: [] }); // restore defaults for other tests
});

test("update = new version, requires why, keeps history, writes audit", async () => {
  const sku = await call(A, "POST", "/api/skus", { code: "V1", name: "v1" });
  const id = sku.json.data.id;
  assert.equal((await call(A, "PATCH", `/api/skus/${id}`, { name: "v2" })).status, 400);
  const up = await call(A, "PATCH", `/api/skus/${id}`, { name: "v2", why: "rename" });
  assert.equal(up.status, 200);
  assert.equal(up.json.data.version, 2);
  assert.equal((await call(A, "PATCH", `/api/skus/${id}`, { name: "v3", why: "stale" })).status, 409);
  assert.equal((await call(A, "PATCH", `/api/skus/${up.json.data.id}`, { code: "X", why: "k" })).status, 400);
  const hist = await call(A, "GET", `/api/skus/${up.json.data.id}/history`);
  assert.deepEqual(hist.json.data.map((r: { version: number; is_current: boolean }) => [r.version, r.is_current]),
    [[1, false], [2, true]]);
  const del = await call(A, "DELETE", `/api/skus/${up.json.data.id}`, { why: "discontinued" });
  assert.equal(del.status, 204);
  const cur = await call(A, "GET", "/api/skus?code=V1");
  assert.equal(cur.json.count, 0);
});

test("cross-tenant: B cannot see or reference A's rows", async () => {
  const nA = await call(A, "POST", "/api/nodes", { code: "ISO", name: "iso", node_type: "outro" });
  assert.equal((await call(B, "GET", `/api/nodes/${nA.json.data.id}`)).status, 404);
  const listB = await call(B, "GET", "/api/nodes");
  assert.ok(listB.json.data.every((r: { tenant_id: string }) => r.tenant_id === B.tenantId));
  const capB = await call(B, "POST", "/api/node_capacity", { node_id: nA.json.data.id, capacity_t_month: 1 });
  assert.equal(capB.status, 400);
  assert.equal(capB.json.error, "invalid_reference");
});

test("auth stub + legacy underscore/singular paths stay 404 (real routes are hyphen/plural: a4-runs, decision-events, scenarios)", async () => {
  assert.equal((await fetch(base + "/api/nodes")).status, 401);
  assert.equal((await fetch(base + "/api/premise_cards")).status, 401);
  for (const p of ["/api/scenario", "/api/a4_runs", "/api/decision_events"]) {
    assert.equal((await call(A, "GET", p)).status, 404, p);
  }
});

test("tenant_settings defaults are empty/generic", async () => {
  const s = await call(B, "GET", "/api/tenant-settings");
  assert.deepEqual(
    { currency: s.json.data.currency, uom: s.json.data.uom, node_types: s.json.data.node_types, kpi_labels: s.json.data.kpi_labels },
    { currency: null, uom: null, node_types: [], kpi_labels: {} });
});

test("W1 premise_cards: Gap card references current node by stable_id", async () => {
  const scn = await ownerCreateScenario(A.tenantId, "SCN-GAP-1");
  const n = await call(A, "POST", "/api/nodes", { code: "GAP-N1", name: "Gap node", node_type: "x" });
  const sid = n.json.data.stable_id;
  const card = { scenario_id: scn, card_id: "PC-1", type: "Gap", status: "gap", source: "edit", fields: { note: "falta capacidade" } };

  // Gap sem node_id → 400 invalid_reference (W2; antes do banco)
  const noNode = await call(A, "POST", "/api/premise_cards", card);
  assert.equal(noNode.status, 400, JSON.stringify(noNode.json));

  const ok = await call(A, "POST", "/api/premise_cards", { ...card, node_id: sid });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.data.node_id, sid);
  assert.deepEqual(ok.json.data.links, { nodeId: sid });
  assert.equal(ok.json.data.version, 1);

  // nó vai para v2: card continua resolvendo pelo stable_id; id da linha v2 NÃO é referência válida
  const v2 = await call(A, "PATCH", `/api/nodes/${n.json.data.id}`, { name: "Gap node v2", why: "rename" });
  assert.equal(v2.status, 200);
  assert.notEqual(v2.json.data.id, sid);
  const byNode = await call(A, "GET", `/api/premise_cards?node_id=${sid}`);
  assert.equal(byNode.json.count, 1);
  const verId = await call(A, "POST", "/api/premise_cards", { ...card, card_id: "PC-2", node_id: v2.json.data.id });
  assert.equal(verId.status, 400);
  assert.equal(verId.json.error, "invalid_reference");
  assert.equal(verId.json.details.field, "links.nodeId"); // W2: nome do contrato

  // PATCH: why obrigatório; versão do card sobe; Gap não pode perder node_id
  assert.equal((await call(A, "PATCH", `/api/premise_cards/${ok.json.data.id}`, { status: "ok" })).status, 400);
  const p = await call(A, "PATCH", `/api/premise_cards/${ok.json.data.id}`, { status: "ok", why: "resolvido" });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.data.version, 2);
  assert.equal((await call(A, "PATCH", `/api/premise_cards/${ok.json.data.id}`, { node_id: null, why: "x" })).status, 400);

  // nó aposentado → invalid_reference
  const n2 = await call(A, "POST", "/api/nodes", { code: "GAP-N2", name: "Retired", node_type: "x" });
  assert.equal((await call(A, "DELETE", `/api/nodes/${n2.json.data.id}`, { why: "fechou" })).status, 204);
  const retired = await call(A, "POST", "/api/premise_cards", { ...card, card_id: "PC-3", node_id: n2.json.data.stable_id });
  assert.equal(retired.status, 400);
  assert.equal(retired.json.error, "invalid_reference");

  // não-Gap sem nó é ok
  const plain = await call(A, "POST", "/api/premise_cards", { ...card, card_id: "PC-4", type: "CurvaDemanda", status: "ok" });
  assert.equal(plain.status, 201, JSON.stringify(plain.json));
  assert.equal(plain.json.data.links.nodeId, null);
});

test("W1 premise_cards: cross-tenant node and scenario are rejected", async () => {
  const scnA = await ownerCreateScenario(A.tenantId, "SCN-X-A");
  const scnB = await ownerCreateScenario(B.tenantId, "SCN-X-B");
  const nA = await call(A, "POST", "/api/nodes", { code: "X-NA", name: "A node", node_type: "x" });
  const base = { card_id: "PC-X", type: "Gap", status: "gap", source: "edit" };
  // B usa nó de A → invalid_reference (RLS na API)
  const r1 = await call(B, "POST", "/api/premise_cards", { ...base, scenario_id: scnB, node_id: nA.json.data.stable_id });
  assert.equal(r1.status, 400);
  assert.equal(r1.json.error, "invalid_reference");
  // A usa cenário de B → FK composta (tenant_id, scenario_id)
  const r2 = await call(A, "POST", "/api/premise_cards", { ...base, scenario_id: scnB, node_id: nA.json.data.stable_id });
  assert.equal(r2.status, 400, JSON.stringify(r2.json));
  assert.equal(r2.json.error, "invalid_reference");
  // B não enxerga cards de A
  await call(A, "POST", "/api/premise_cards", { ...base, scenario_id: scnA, node_id: nA.json.data.stable_id });
  const listB = await call(B, "GET", "/api/premise_cards");
  assert.ok(listB.json.data.every((c: { tenant_id: string }) => c.tenant_id === B.tenantId));
});
