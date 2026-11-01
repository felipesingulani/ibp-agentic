// W7 · Task 13 — GET /api/plans/approved/export?format=json|csv (docs/architecture/W7-PLAN-EXPORT-CONTRACT.md).
// Fixtures via owner; leitura via app (RLS). Ordem: 401 → 403 → 400 → 409 → 200; audit só no 200.
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
type Who = { tenantId: string; userId: string | null };
let server: { close(): void }, base = "";

async function call(who: Who | null, method: string, path: string, body?: unknown) {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (who) h["x-tenant-id"] = who.tenantId;
  if (who?.userId) h["x-user-id"] = who.userId;
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8");
  let json: any = null; try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, headers: res.headers, buf, text, json };
}
const get = (who: Who | null, path: string) => call(who, "GET", path);
const exp = (who: Who | null, format?: string) => get(who, `/api/plans/approved/export${format === undefined ? "" : `?format=${format}`}`);
const q = (sql: string, p: unknown[] = []) => owner.query(sql, p).then((r) => r.rows);
const code = (p = "W7") => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const audits = async (tenantId: string) =>
  Number((await q("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'export'", [tenantId]))[0].n);

const PLAN = {
  objective: 98765.4321, solverStatus: "Optimal", wallMs: 17, period: "2026-11",
  totals: { demand: 300, served: 250.5, unmet: 49.5, fillRate: 0.835 },
  flows: [{ routeId: "aaaaaaaa-0000-4000-8000-000000000001", routeCode: "FAB-SP→CD, RJ", skuId: "bbbbbbbb-0000-4000-8000-000000000001", skuCode: "SKU-Ç", qty: 120.25 }],
  local: [{ nodeId: "cccccccc-0000-4000-8000-000000000001", skuId: "bbbbbbbb-0000-4000-8000-000000000001", qty: 130.25 }],
  unmet: [{ nodeId: "cccccccc-0000-4000-8000-000000000002", skuId: "bbbbbbbb-0000-4000-8000-000000000001", qty: 49.5 }],
  utilization: [{ nodeId: "cccccccc-0000-4000-8000-000000000001", code: "Fábrica São Paulo", used: 250.5, capacity: 300, pct: 83.5 }],
  params: { weights: { unmet: 1000 }, horizon: null }, reasonCandidates: 3,
};

async function tenants() {
  const t = await setupTwoTenants();
  const user = async (tenantId: string, role: string) =>
    (await q("INSERT INTO users (tenant_id, email, role) VALUES ($1, $2, $3) RETURNING id", [tenantId, `${role}-${code()}@t.test`, role]))[0].id as string;
  const A = { tenantId: t.a.tenantId, userId: t.a.adminUserId };
  const as = async (role: string) => ({ tenantId: A.tenantId, userId: await user(A.tenantId, role) });
  return { A, B: { tenantId: t.b.tenantId, userId: t.b.adminUserId },
    ADo: await as("domain_owner"), AFin: await as("finance"), ASales: await as("sales"), ASupply: await as("supply") };
}
async function run(tenantId: string, sc: string, plan: unknown, ago = 0, version = 1) {
  const rc = code("R");
  const id = (await q(
    `INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status, reasons, counts_by_kind, plan, started_at, finished_at)
     VALUES ($1,$2,$3,$4,'feasible','[]','{}',$5, now() - make_interval(secs => $6), now() - make_interval(secs => $6)) RETURNING id`,
    [tenantId, rc, sc, version, JSON.stringify(plan), ago]))[0].id as string;
  return { id, runCode: rc };
}
const approve = (who: Who, sc: string, runId: string) =>
  call(who, "POST", "/api/decision-events", { scenario_id: sc, run_id: runId, action: "approve", why: "ok export" });

before(async () => {
  await owner.connect();
  server = createApp(pool).listen(0);
  await new Promise<void>((r) => (server as unknown as { once(e: string, f: () => void): void }).once("listening", r));
  base = `http://127.0.0.1:${((server as unknown as { address(): AddressInfo }).address()).port}`;
});
after(async () => { server.close(); await owner.end(); await pool.end(); });

test("ordem de checagem: sem user 401 · sales/supply 403 forbidden_role {required} · format inválido 400 · none 409; 0 audit", async () => {
  const { A, ASales, ASupply } = await tenants();
  assert.equal((await exp(null, "json")).status, 401);
  const noUser = await exp({ tenantId: A.tenantId, userId: null }, "json");
  assert.equal(noUser.status, 401, noUser.text);
  for (const who of [ASales, ASupply]) {
    for (const f of ["json", "csv", "xlsx", undefined]) { // papel antes do format
      const r = await exp(who, f);
      assert.equal(r.status, 403, r.text);
      assert.deepEqual(r.json, { error: "forbidden_role", details: { required: ["admin", "domain_owner", "finance"] } });
    }
  }
  for (const f of [undefined, "", "xlsx", "JSON", "json&format=csv"]) {
    const r = await exp(A, f);
    assert.equal(r.status, 400, `${f} ${r.text}`);
    assert.equal(r.json.error, "validation_failed"); assert.equal(r.json.details.field, "format");
  }
  for (const f of ["json", "csv"]) { // tenant vazio → none
    const r = await exp(A, f);
    assert.equal(r.status, 409, r.text);
    assert.deepEqual(r.json, { error: "no_approved_plan", details: { basis: "none" } });
  }
  assert.equal(await audits(A.tenantId), 0);
});

test("latest_run (sem approve) → 409 {basis:latest_run}, nunca exporta; approve → 200 JSON cru + planRef = Pulse + audit 1", async () => {
  const { A, ADo, AFin } = await tenants();
  await q("UPDATE tenant_settings SET currency='BRL', uom=NULL WHERE tenant_id=$1", [A.tenantId]);
  const sc = await ownerCreateScenario(A.tenantId, code("SC"));
  const r1 = await run(A.tenantId, sc, PLAN, 60);
  const latest = await exp(A, "json");
  assert.equal(latest.status, 409, latest.text);
  assert.deepEqual(latest.json, { error: "no_approved_plan", details: { basis: "latest_run" } });
  assert.equal(await audits(A.tenantId), 0);

  assert.equal((await approve(A, sc, r1.id)).status, 201);
  const r2 = await run(A.tenantId, sc, { ...PLAN, objective: 1 }, 0); // run mais novo, não aprovado → não é exportado
  const pulse = (await get(A, "/api/pulse/summary")).json.data.planRef;
  assert.equal(pulse.basis, "approved"); assert.equal(pulse.runId, r1.id);
  for (const who of [A, ADo, AFin]) {
    const r = await exp(who, "json");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("etag"), null, "sem ETag: nada de 304 sobre um 200 auditado");
    assert.equal(r.headers.get("content-disposition"), `attachment; filename="plan-${sc}-v1-${r1.runCode}.json"`);
    const d = r.json;
    assert.equal(d.exportVersion, "w7.v0");
    assert.ok(!Number.isNaN(Date.parse(d.exportedAt)));
    assert.deepEqual(d.planRef, pulse);
    assert.notEqual(d.planRef.runId, r2.id);
    assert.equal(d.run.runCode, r1.runCode); assert.equal(d.run.status, "feasible");
    assert.deepEqual(d.settings, { currency: "BRL", uom: null });
    const { reasonCandidates: _x, ...raw } = PLAN;
    assert.deepEqual(d.plan, raw);
    const stored = (await q("SELECT plan FROM a4_runs WHERE id = $1", [r1.id]))[0].plan;
    delete stored.reasonCandidates;
    assert.deepEqual(d.plan, stored);
  }
  assert.equal(await audits(A.tenantId), 3);
  const a = (await q("SELECT actor_user_id, actor_role, entity, entity_id, payload FROM audit_log WHERE tenant_id=$1 AND action='export' ORDER BY id", [A.tenantId]));
  assert.deepEqual(a.map((x) => x.actor_role), ["admin", "domain_owner", "finance"]);
  assert.ok(a.every((x) => x.entity === "a4_runs" && x.entity_id === r1.id));
  assert.deepEqual(a[0].payload, { format: "json", planRef: pulse });
});

test("CSV: BOM, # planRef, header fixo, seções, null → vazio, números = JSON; audit format csv", async () => {
  const { A, AFin } = await tenants();
  await q("UPDATE tenant_settings SET currency='BRL', uom='m3' WHERE tenant_id=$1", [A.tenantId]);
  const sc = await ownerCreateScenario(A.tenantId, code("SC"));
  const plan = { ...PLAN, objective: null, totals: { ...PLAN.totals, fillRate: null } };
  const r1 = await run(A.tenantId, sc, plan);
  assert.equal((await approve(A, sc, r1.id)).status, 201);
  const j = (await exp(AFin, "json")).json;
  const r = await exp(AFin, "csv");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("etag"), null);
  assert.equal(r.headers.get("content-disposition"), `attachment; filename="plan-${sc}-v1-${r1.runCode}.csv"`);
  assert.deepEqual([...r.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const lines = r.text.slice(1).split("\r\n");
  assert.ok(lines[0].startsWith(`# exportVersion=w7.v0;basis=approved;scenarioId=${sc};scenarioVersion=1;runId=${r1.id};runCode=${r1.runCode};approvedAt=${j.planRef.at};exportedAt=`), lines[0]);
  assert.ok(lines[0].endsWith(";currency=BRL;uom=m3"));
  assert.equal(lines[1], "section,metric,node_id,node_code,route_id,route_code,sku_id,sku_code,qty,used,capacity,pct,value");
  assert.deepEqual(lines.slice(2, -1).map((l) => l.split(",")[0]),
    ["total", "total", "total", "total", "total", "total", "total", "flow", "local", "unmet", "utilization"]);
  assert.ok(lines.includes("total,objective,,,,,,,,,,,")); assert.ok(lines.includes("total,fillRate,,,,,,,,,,,"));
  assert.ok(lines.includes(`total,served,,,,,,,,,,,${j.plan.totals.served}`));
  assert.ok(lines.includes(`flow,,,,${PLAN.flows[0].routeId},"FAB-SP→CD, RJ",${PLAN.flows[0].skuId},SKU-Ç,120.25,,,,`));
  assert.ok(lines.includes(`utilization,,${PLAN.utilization[0].nodeId},Fábrica São Paulo,,,,,,250.5,300,83.5,`));
  assert.ok(!/null/.test(r.text));
  const a = await q("SELECT payload FROM audit_log WHERE tenant_id=$1 AND action='export' ORDER BY id", [A.tenantId]);
  assert.deepEqual(a.map((x) => x.payload.format), ["json", "csv"]);
});

test("aprovação de versão superada → 409; RLS: B com approve próprio exporta só o seu, sem approve → 409", async () => {
  const { A, B } = await tenants();
  const sa = await ownerCreateScenario(A.tenantId, code("SC"));
  const ra = await run(A.tenantId, sa, PLAN);
  assert.equal((await approve(A, sa, ra.id)).status, 201);
  assert.equal((await exp(B, "json")).json.details.basis, "none"); // B não vê o approve de A
  const sb = await ownerCreateScenario(B.tenantId, code("SC"));
  const rb = await run(B.tenantId, sb, { ...PLAN, objective: 7 });
  assert.deepEqual((await exp(B, "csv")).json, { error: "no_approved_plan", details: { basis: "latest_run" } });
  assert.equal((await approve(B, sb, rb.id)).status, 201);
  const eb = await exp(B, "json");
  assert.equal(eb.status, 200); assert.equal(eb.json.planRef.runId, rb.id); assert.equal(eb.json.plan.objective, 7);
  const ea = await exp(A, "json");
  assert.equal(ea.json.planRef.runId, ra.id); assert.equal(ea.json.plan.objective, PLAN.objective);
  await q("UPDATE scenarios SET version = 2 WHERE id = $1", [sa]); // approve v1 superada → resolvePlanRef cai p/ latest_run → 409 (nunca exporta)
  const sup = await exp(A, "json");
  assert.equal(sup.status, 409, sup.text); assert.equal(sup.json.error, "no_approved_plan");
  assert.notEqual(sup.json.details.basis, "approved");
  assert.equal(await audits(A.tenantId), 1); assert.equal(await audits(B.tenantId), 1);
});

test("só GET: sem rota de escrita/variação em /api/plans", async () => {
  const { A } = await tenants();
  assert.equal((await call(A, "POST", "/api/plans/approved/export?format=json", {})).status, 405); // non-GET no export → 405
  for (const [m, p] of [["GET", "/api/plans/latest/export?format=json"],
    ["GET", "/api/plans"]] as const) {
    assert.equal((await call(A, m, p, undefined)).status, 404, `${m} ${p}`);
  }
});

test("HEAD/POST no export → 405 Allow: GET, 0 audit; GET segue 200 + audit", async () => {
  const { A } = await tenants();
  const sc = await ownerCreateScenario(A.tenantId, code("SC"));
  const { id } = await run(A.tenantId, sc, PLAN);
  assert.equal((await approve(A, sc, id)).status < 300, true);
  const before0 = await audits(A.tenantId);
  for (const m of ["HEAD", "POST", "PUT", "DELETE"]) {
    const r = await call(A, m, "/api/plans/approved/export?format=csv");
    assert.equal(r.status, 405, m);
    assert.equal(r.headers.get("allow"), "GET");
  }
  assert.equal(await audits(A.tenantId), before0);
  assert.equal((await exp(A, "csv")).status, 200);
  assert.equal(await audits(A.tenantId), before0 + 1);
});
