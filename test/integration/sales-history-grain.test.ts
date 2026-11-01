// T-DM-PERIOD-GRAIN + T-DM-SALESHIST-UQ — API (zod/409) + DB (CHECK/UNIQUE da 0018), isolamento por tenant.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { createApp } from "../../src/http/app.js";
import { makePool } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import { setupTwoTenants } from "./helpers.js";

type Who = { tenantId: string; adminUserId: string };
const pool = makePool(env.databaseUrl);
let base = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let A: Who; let B: Who;
const ids: Record<string, string> = {};

async function call(who: Who, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-tenant-id": who.tenantId, "x-user-id": who.adminUserId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const count = async (who: Who) => (await call(who, "GET", "/api/sales_history")).json.count as number;

before(async () => {
  ({ a: A, b: B } = await setupTwoTenants());
  server = createApp(pool).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [k, who] of [["A", A], ["B", B]] as const) {
    ids[`${k}n`] = (await call(who, "POST", "/api/nodes", { code: "TDM-N", name: "n", node_type: "outro" })).json.data.stable_id;
    ids[`${k}s`] = (await call(who, "POST", "/api/skus", { code: "TDM-S", name: "s" })).json.data.stable_id;
  }
});
after(async () => { server.close(); await pool.end(); });

const row = (k: "A" | "B", o: Record<string, unknown> = {}) => ({ node_id: ids[`${k}n`], sku_id: ids[`${k}s`], period: "2026-10", qty: 10, ...o });

test("M2 period só mês (API): YYYY-MM 201; dia/vazio/2026-13 → 400 validation_failed (period) sem gravar", async () => {
  const n0 = await count(A);
  for (const bad of ["2026-10-15", "2026-10-01", "", "2026-13", "202610"]) {
    for (const body of [row("A", { period: bad }), { rows: [row("A", { period: bad })] }]) {
      const r = await call(A, "POST", "/api/sales_history", body);
      assert.equal(r.status, 400, bad);
      assert.equal(r.json.error, "validation_failed");
      assert.deepEqual(r.json.details[0].path, ["period"]);
    }
  }
  assert.equal(await count(A), n0);
  const ok = await call(A, "POST", "/api/sales_history", row("A", { period: "2026-01" }));
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  // filtro period_from/period_to também só mês
  assert.equal((await call(A, "GET", "/api/sales_history?period_from=2026-01-01")).status, 400);
  assert.equal((await call(A, "GET", "/api/sales_history?period_to=2026-1")).status, 400);
  const f = await call(A, "GET", "/api/sales_history?period_from=2026-01&period_to=2026-01");
  assert.equal(f.status, 200); assert.equal(f.json.count, 1);
});

test("M3/H3 UNIQUE + qty: re-POST mesma chave → 409 strict; qty=-1 → 400; qty=0 ok; source distinto ok", async () => {
  const first = await call(A, "POST", "/api/sales_history", row("A", { period: "2026-02", qty: 0 }));
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const n0 = await count(A);
  const dup = await call(A, "POST", "/api/sales_history", row("A", { period: "2026-02", qty: 99 }));
  assert.equal(dup.status, 409); assert.equal(dup.json.error, "conflict");
  assert.equal(dup.json.detail, "sales_history_tenant_node_sku_period_source_key");
  // default source ('extract') explícito colide igual
  assert.equal((await call(A, "POST", "/api/sales_history", row("A", { period: "2026-02", source: "extract" }))).status, 409);
  const neg = await call(A, "POST", "/api/sales_history", row("A", { period: "2026-03", qty: -1 }));
  assert.equal(neg.status, 400); assert.deepEqual(neg.json.details[0].path, ["qty"]);
  assert.equal(await count(A), n0);
  assert.equal((await call(A, "POST", "/api/sales_history", row("A", { period: "2026-02", source: "manual" }))).status, 201);
});

test("H2 batch all-or-nothing: 1 linha inválida → 400; 2 linhas mesma chave → 409; zero parcial", async () => {
  const n0 = await count(A);
  const day = await call(A, "POST", "/api/sales_history", { rows: [row("A", { period: "2026-04" }), row("A", { period: "2026-05-01" })] });
  assert.equal(day.status, 400);
  const neg = await call(A, "POST", "/api/sales_history", { rows: [row("A", { period: "2026-04" }), row("A", { period: "2026-05", qty: -2 })] });
  assert.equal(neg.status, 400);
  const twin = await call(A, "POST", "/api/sales_history", { rows: [row("A", { period: "2026-04" }), row("A", { period: "2026-04", qty: 3 })] });
  assert.equal(twin.status, 409);
  assert.equal(await count(A), n0);
});

test("H1 isolamento: tenant B repete a mesma (node,sku,period,source) de A sem conflito", async () => {
  assert.equal((await call(A, "POST", "/api/sales_history", row("A", { period: "2026-06" }))).status, 201);
  assert.equal((await call(B, "POST", "/api/sales_history", row("B", { period: "2026-06" }))).status, 201);
  assert.equal((await call(B, "POST", "/api/sales_history", row("B", { period: "2026-06" }))).status, 409);
});

test("M1/H4 DB: CHECK period_ym + qty_nonneg + UNIQUE valem mesmo fora da API (owner raw SQL)", async () => {
  const c = new pg.Client({ connectionString: env.migrationDatabaseUrl });
  await c.connect();
  try {
    const ins = (period: string, qty: number) => c.query(
      "INSERT INTO sales_history (tenant_id, node_id, sku_id, period, qty) VALUES ($1,$2,$3,$4,$5)",
      [A.tenantId, ids.An, ids.As, period, qty]);
    const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return `${(e as { code?: string }).code}:${(e as { constraint?: string }).constraint}`; } };
    assert.equal(await code(ins("2026-07", 1)), "ok");
    for (const bad of ["2026-10-15", "2026-10-01", "202610", "2026/10", "2026-13"]) {
      assert.equal(await code(ins(bad, 1)), "23514:sales_history_period_ym", bad);
    }
    assert.equal(await code(ins("2026-08", -1)), "23514:sales_history_qty_nonneg");
    assert.equal(await code(ins("2026-08", 0)), "ok");
    assert.equal(await code(ins("2026-07", 5)), "23505:sales_history_tenant_node_sku_period_source_key");
  } finally { await c.end(); }
});
