// 0010 confirmed_at: PUT/GET tenant-settings; unlock helper na prontidão sem alterar `state`; RLS entre tenants.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp } from "../../src/http/app.js";
import { makePool } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import { setupTwoTenants } from "./helpers.js";

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
const settings = async (w: Who) => (await call(w, "GET", "/api/tenant-settings")).json.data;
const readiness = async (w: Who) => (await call(w, "GET", "/api/a4-readiness")).json.data;

before(async () => {
  ({ a: A, b: B } = await setupTwoTenants());
  server = createApp(pool).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server.close(); await pool.end(); });

test("confirmed_at: null by default; confirm stamps server now(); other PUTs keep it; unconfirm clears; client timestamp rejected", async () => {
  assert.equal((await settings(A)).confirmed_at, null);
  const t0 = Date.now();
  const put = await call(A, "PUT", "/api/tenant-settings", { confirmed: true });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const at = Date.parse(put.json.data.confirmed_at);
  assert.ok(Number.isFinite(at) && Math.abs(at - t0) < 60_000, put.json.data.confirmed_at);
  assert.equal((await settings(A)).confirmed_at, put.json.data.confirmed_at);
  await call(A, "PUT", "/api/tenant-settings", { currency: "XYZ" }); // sem o campo → mantém
  assert.equal((await settings(A)).confirmed_at, put.json.data.confirmed_at);
  assert.equal((await call(A, "PUT", "/api/tenant-settings", { confirmed_at: "2020-01-01T00:00:00Z" })).status, 400);
  assert.equal((await call(A, "PUT", "/api/tenant-settings", { confirmed: "yes" })).status, 400);
  // B não é afetado
  assert.equal((await settings(B)).confirmed_at, null);
  const off = await call(A, "PUT", "/api/tenant-settings", { confirmed: false });
  assert.equal(off.json.data.confirmed_at, null);
});

test("unlock helper: new_scenario = confirmed && state≠block; state ignores confirmed_at", async () => {
  // B vazio → block
  let r = await readiness(B);
  assert.equal(r.state, "block");
  assert.deepEqual(r.unlock, { confirmed: false, confirmed_at: null, ready: false, new_scenario: false });
  await call(B, "PUT", "/api/tenant-settings", { confirmed: true }); // 1º PUT do tenant (INSERT) confirma
  r = await readiness(B);
  assert.equal(r.state, "block", "confirmar não muda state");
  assert.deepEqual([r.unlock.confirmed, r.unlock.ready, r.unlock.new_scenario], [true, false, false]);
  // cadastro mínimo → ready
  const n1 = (await call(B, "POST", "/api/nodes", { code: "N1", name: "n1", node_type: "outro" })).json.data;
  const n2 = (await call(B, "POST", "/api/nodes", { code: "N2", name: "n2", node_type: "outro" })).json.data;
  await call(B, "POST", "/api/policies", { kind: "capital de giro", name: "wc", body: {} });
  await call(B, "POST", "/api/node_capacity", { node_id: n1.stable_id, capacity_per_period: 10 });
  await call(B, "POST", "/api/routes", { code: "R1", origin_node_id: n1.stable_id, dest_node_id: n2.stable_id });
  r = await readiness(B);
  assert.equal(r.state, "block", "coach B (v0.3.10): sem SKU segue block");
  await call(B, "POST", "/api/skus", { code: "S1", name: "Item" });
  r = await readiness(B);
  assert.equal(r.state, "warn"); // N2 sem capacidade — warn não bloqueia
  assert.deepEqual([r.unlock.confirmed, r.unlock.ready, r.unlock.new_scenario], [true, true, true]);
  await call(B, "PUT", "/api/tenant-settings", { confirmed: false });
  const r2 = await readiness(B);
  assert.equal(r2.state, r.state, "desconfirmar não muda state");
  assert.deepEqual([r2.unlock.confirmed, r2.unlock.ready, r2.unlock.new_scenario], [false, true, false]);
});
