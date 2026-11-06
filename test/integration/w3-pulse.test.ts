// W3 · Task 8 — Pulse + Visões + fila de alçada (GET only) + DecisionEvent v0.2 no POST. Fixtures via owner; leitura via app (RLS).
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { createApp } from "../../src/http/app.js";
import { makePool } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import { ownerCreateScenario, setupTwoTenants } from "./helpers.js";
import { validateAlcadaItem, validateDecisionEvent } from "../support/schemas.js";

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
const get = (who: Who | null, path: string) => call(who, "GET", path);
const decide = (who: Who, body: Record<string, unknown>) => call(who, "POST", "/api/decision-events", body);
const q = (sql: string, p: unknown[] = []) => owner.query(sql, p).then((r) => r.rows);
const code = (p = "W3") => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const LONG = "Aprovo: investimento justificado pelo ganho de serviço.";

async function tenants() {
  const t = await setupTwoTenants();
  const user = async (tenantId: string, role: string) =>
    (await q("INSERT INTO users (tenant_id, email, role) VALUES ($1, $2, $3) RETURNING id", [tenantId, `${role}-${code()}@t.test`, role]))[0].id as string;
  const A = { tenantId: t.a.tenantId, userId: t.a.adminUserId };
  return { A, B: { tenantId: t.b.tenantId, userId: t.b.adminUserId },
    ASales: { tenantId: A.tenantId, userId: await user(A.tenantId, "sales") },
    AFin: { tenantId: A.tenantId, userId: await user(A.tenantId, "finance") } };
}
async function scenario(tenantId: string, c = code("SC"), leg?: string) {
  const id = await ownerCreateScenario(tenantId, c);
  if (leg) await q("UPDATE scenarios SET leg = $2 WHERE id = $1", [id, leg]);
  return id;
}
const card = (tenantId: string, sc: string, type: string, fields: unknown, status = "ok", nodeId: string | null = null) =>
  q(`INSERT INTO premise_cards (tenant_id, scenario_id, card_id, type, fields, status, node_id, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'edit')`, [tenantId, sc, code("PC"), type, JSON.stringify(fields), status, nodeId]);
async function run(tenantId: string, sc: string, status: string, o: { plan?: unknown; reasons?: unknown[]; counts?: unknown; ago?: number; version?: number } = {}) {
  return (await q(
    `INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status, reasons, counts_by_kind, plan, started_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() - make_interval(secs => $9), now() - make_interval(secs => $9))
     RETURNING id`, [tenantId, code("R"), sc, o.version ?? 1, status, JSON.stringify(o.reasons ?? []),
      JSON.stringify(o.counts ?? {}), o.plan === undefined ? null : JSON.stringify(o.plan), o.ago ?? 0]))[0].id as string;
}
const policy = (tenantId: string, kind: string, body: unknown) =>
  q("INSERT INTO policies (tenant_id, kind, name, body) VALUES ($1,$2,$2,$3) RETURNING stable_id", [tenantId, kind, JSON.stringify(body)]);

before(async () => {
  await owner.connect();
  server = createApp(pool).listen(0);
  await new Promise<void>((r) => (server as unknown as { once(e: string, f: () => void): void }).once("listening", r));
  base = `http://127.0.0.1:${((server as unknown as { address(): AddressInfo }).address()).port}`;
});
after(async () => { server.close(); await owner.end(); await pool.end(); });

test("empty tenant: basis none, 4 KPIs null+nullReason, checklist + nextStep config, sem número inventado; fila no_policy", async () => {
  const { A } = await tenants();
  const s = await get(A, "/api/pulse/summary");
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const d = s.json.data;
  assert.deepEqual(d.planRef, { basis: "none", scenarioId: null, scenarioVersion: null, runId: null, at: null });
  assert.equal(d.empty, true);
  assert.deepEqual(d.kpis.map((k: { key: string }) => k.key), ["svc", "cost", "viol", "wc"]);
  assert.deepEqual(d.kpis.map((k: { nullReason: string | null }) => k.nullReason), ["no_plan", "no_plan", null, "no_plan"]);
  assert.equal(d.kpis[0].value, null); assert.equal(d.kpis[1].value, null); assert.equal(d.kpis[3].value, null);
  assert.equal(d.readiness.state, "block"); assert.ok(Array.isArray(d.readiness.items));
  assert.deepEqual(d.unlock, { newScenario: false }); assert.deepEqual(d.pending, { alcada: 0, staleScenarios: 0, executionExceptions: 0 });
  assert.deepEqual([d.execution.movements, d.execution.adherence.value, d.execution.adherence.nullReason], [0, null, "no_plan"]); // W4
  assert.equal(d.nextStep.key, "config");
  const ex = await get(A, "/api/pulse/exceptions");
  assert.ok(ex.json.data.length > 0 && ex.json.data.every((e: { source: string; severity: string; action: string }) =>
    e.source === "readiness" && e.severity === "block" && e.action === "open_cadastro"));
  assert.equal(d.kpis[2].value, ex.json.data.length); // viol = contagem real (block+warn) das exceções
  const qq = await get(A, "/api/alcada/queue");
  assert.deepEqual({ ...qq.json, notice: undefined }, { data: [], mode: "no_policy", policy: null, notice: undefined, needsPolicy: 0,
    nextStep: { key: "publish_alcada", label: "Publicar a política de alçada", cta: "Publicar alçada", endpoint: "PUT /api/cadastro/alcada" } });
  for (const lens of ["sales", "supply", "finance"]) {
    const v = (await get(A, `/api/visoes/${lens}?node=x`)).json.data; // query desconhecida ignorada
    assert.equal(v.lens, lens); assert.equal(v.empty, true); assert.deepEqual(v.planRef, d.planRef);
  }
  const sales = (await get(A, "/api/visoes/sales")).json.data;
  assert.equal(sales.cards.find((k: { key: string }) => k.key === "demand_3p").nullReason, "no_data");
  assert.equal(sales.cards.find((k: { key: string }) => k.key === "nodes_current").value, 0); // 0 real ≠ null
  assert.deepEqual(sales.action, { kind: "new_scenario", enabled: false, disabledReason: "a4_not_ready" });
});

test("contrato HTTP: sem x-tenant-id → 401; lente inválida → 400 invalid_lens; filtros inválidos → 400", async () => {
  const { A } = await tenants();
  for (const p of ["/api/pulse/summary", "/api/pulse/exceptions", "/api/alcada/queue", "/api/visoes/sales"]) {
    const r = await get(null, p);
    assert.equal(r.status, 401, p); assert.equal(r.json.error, "missing_or_invalid_x-tenant-id");
  }
  const bad = await get(A, "/api/visoes/marketing");
  assert.equal(bad.status, 400); assert.equal(bad.json.error, "invalid_lens");
  assert.equal((await get(A, "/api/pulse/exceptions?severity=critical")).status, 400);
  assert.equal((await get(A, "/api/alcada/queue?status=open")).status, 400);
});

test("planRef: approved > latest_run (não aprovado) > none; aprovação de versão superada não é plano; failed não conta", async () => {
  const { A } = await tenants();
  const s1 = await scenario(A.tenantId), s2 = await scenario(A.tenantId);
  const plan = (fill: number) => ({ objective: 100, totals: { demand: 50, served: 40, unmet: 10, fillRate: fill }, utilization: [] });
  const r1 = await run(A.tenantId, s1, "feasible", { plan: plan(0.7), ago: 60 });
  const r2 = await run(A.tenantId, s2, "partial", { plan: plan(0.9), ago: 30 });
  await run(A.tenantId, s2, "failed", { ago: 1 });
  let ref = (await get(A, "/api/pulse/summary")).json.data;
  assert.equal(ref.planRef.basis, "latest_run"); assert.equal(ref.planRef.runId, r2); assert.equal(ref.kpis[0].value, 0.9);
  assert.equal((await decide(A, { scenario_id: s1, run_id: r1, action: "approve", why: "ok" })).status, 201);
  ref = (await get(A, "/api/pulse/summary")).json.data;
  assert.equal(ref.planRef.basis, "approved"); assert.equal(ref.planRef.runId, r1); assert.equal(ref.planRef.scenarioVersion, 1);
  assert.equal(ref.kpis[0].value, 0.7); assert.equal(ref.kpis[0].source, "a4_run.plan.totals.fillRate");
  await q("UPDATE scenarios SET version = 2 WHERE id = $1", [s1]); // versão nova → aprovação v1 superada
  ref = (await get(A, "/api/pulse/summary")).json.data;
  assert.equal(ref.planRef.basis, "latest_run"); assert.equal(ref.planRef.runId, r2);
  assert.equal(ref.pending.staleScenarios, 1); // s1: último run (v1) ficou stale
  await q("UPDATE scenarios SET status = 'archived' WHERE tenant_id = $1", [A.tenantId]);
  assert.equal((await get(A, "/api/pulse/summary")).json.data.planRef.basis, "none");
});

test("KPI sources + exceções (fontes, dedupe, ordem) + mesma verdade entre summary e as 3 lentes", async () => {
  const { A } = await tenants();
  await q("UPDATE tenant_settings SET currency='BRL', uom='m3', kpi_labels='{\"svc\":\"Serviço\"}' WHERE tenant_id=$1", [A.tenantId]);
  const n1 = (await q("INSERT INTO nodes (tenant_id, code, name, node_type) VALUES ($1,'N1','Nó 1','cd') RETURNING stable_id, id", [A.tenantId]))[0];
  const sku = (await q("INSERT INTO skus (tenant_id, code, name) VALUES ($1,'K1','K1') RETURNING stable_id", [A.tenantId]))[0].stable_id;
  for (const [p, qty] of [["2026-06", 999], ["2026-07", 10], ["2026-08", 20], ["2026-09", 30]] as const) {
    await q("INSERT INTO sales_history (tenant_id, node_id, sku_id, period, qty) VALUES ($1,$2,$3,$4,$5)", [A.tenantId, n1.stable_id, sku, p, qty]);
  }
  const sc = await scenario(A.tenantId, code("SC"), "sales");
  await card(A.tenantId, sc, "Gap", { need: "capacidade extra" }, "gap", n1.stable_id);
  await card(A.tenantId, sc, "Investimento", { impactMi: 3 });
  await card(A.tenantId, sc, "CurvaDemanda", { growth: 0.1 });
  const reasons = [
    { rank: 1, kind: "capacidade", summary: "N1 no limite", refs: { nodeId: n1.stable_id }, severity: "warn" },
    { rank: 2, kind: "contrato", summary: "Contrato mínimo", refs: {}, severity: "block" },
  ];
  const rid = await run(A.tenantId, sc, "partial", { reasons, counts: { contrato: 1, capacidade: 1 },
    plan: { objective: 300, totals: { demand: 150, served: 120, unmet: 30, fillRate: 0.8 }, utilization: [{ pct: 80 }, { pct: 100 }] } });
  const sum = (await get(A, "/api/pulse/summary")).json.data;
  const K = Object.fromEntries(sum.kpis.map((k: { key: string }) => [k.key, k]));
  assert.deepEqual(K.svc, { key: "svc", label: "Serviço", value: 0.8, unit: "ratio", nullReason: null, source: "a4_run.plan.totals.fillRate" });
  assert.equal(K.cost.value, 2.5); assert.equal(K.cost.unit, "BRL/m3");
  const ex = (await get(A, "/api/pulse/exceptions")).json.data;
  assert.equal(K.viol.value, ex.filter((e: { severity: string }) => e.severity !== "info").length);
  const sev = ex.map((e: { severity: string }) => e.severity);
  assert.deepEqual(sev, [...sev].sort((a: string, b: string) => ["block", "warn", "info"].indexOf(a) - ["block", "warn", "info"].indexOf(b)));
  const cap = ex.filter((e: { kind: string; refs: { nodeId: string } }) => e.kind === "capacidade" && e.refs.nodeId === n1.stable_id);
  assert.equal(cap.length, 1); assert.equal(cap[0].source, "a4_run"); assert.equal(cap[0].id, `a4_run:${rid}:1`);
  assert.ok(cap[0].merged.some((m: string) => m.startsWith("premise_gap:")), JSON.stringify(cap[0])); // gap absorvido
  assert.ok(ex.some((e: { source: string; kind: string }) => e.source === "a4_run" && e.kind === "contrato"));
  assert.ok((await get(A, "/api/pulse/exceptions?severity=block")).json.data.every((e: { severity: string }) => e.severity === "block"));

  const [sales, supply, finance] = await Promise.all(["sales", "supply", "finance"].map((l) => get(A, `/api/visoes/${l}`).then((r) => r.json.data)));
  const by = (arr: { key: string; value?: unknown }[], k: string) => arr.find((x) => x.key === k);
  for (const v of [sales, supply, finance]) assert.deepEqual(v.planRef, sum.planRef);
  assert.deepEqual(by(sales.cross, "svc"), K.svc);
  assert.deepEqual(by(supply.cross, "cost"), K.cost); assert.deepEqual(by(finance.cross, "cost"), K.cost);
  assert.deepEqual(by(finance.cards, "wc"), K.wc);
  assert.deepEqual(by(sales.cards, "demand_3p"), by(supply.cross, "demand_3p"));
  assert.equal(by(sales.cards, "demand_3p")!.value as unknown, 60); // 3 últimos períodos (999 de 2026-06 fora)
  assert.equal(by(sales.cross, "pending_alcada")!.value as unknown, sum.pending.alcada);
  assert.equal(by(finance.cards, "pending_alcada")!.value as unknown, sum.pending.alcada);
  assert.equal(by(supply.cards, "util_avg")!.value as unknown, 90); assert.equal(by(supply.cards, "util_max")!.value as unknown, 100);
  assert.deepEqual(by(sales.cross, "util_max"), by(supply.cards, "util_max"));
  assert.equal(by(supply.cards, "contract_reasons")!.value as unknown, 1);
  assert.equal(by(finance.cards, "invest_mi")!.value as unknown, 3);
  assert.equal(by(finance.cross, "volume_premises")!.value as unknown, 1);
  assert.equal(by(sales.cards, "scenarios_sales")!.value as unknown, 1);
  assert.equal(supply.action.kind, "register_gap"); assert.equal(supply.action.enabled, true);
  assert.deepEqual(finance.action, { kind: "alcada_queue", enabled: false, count: 0, disabledReason: "no_policy" });
});

test("alçada: no_policy → misconfigured (fail-closed) → active (> entra, ≤ não, null entra); Finance decide; nova versão → stale", async () => {
  const { A, ASales, AFin } = await tenants();
  const mk = async (imp: unknown) => {
    const c = code("AQ"); const id = await scenario(A.tenantId, c);
    await card(A.tenantId, id, "Investimento", { impactMi: imp });
    return { id, code: c, run: await run(A.tenantId, id, "feasible", { plan: { objective: 1, totals: { served: 1, fillRate: 1 } } }) };
  };
  const low = await mk(5), high = await mk(20), unk = await mk("a definir"), esc = await mk(50);
  await scenario(A.tenantId); // cenário sem Investimento nunca entra
  assert.equal((await get(A, "/api/alcada/queue")).json.mode, "no_policy");

  const [pol] = await policy(A.tenantId, "alcada", { note: "sem limiar" });
  let qq = (await get(A, "/api/alcada/queue")).json;
  assert.equal(qq.mode, "misconfigured"); assert.deepEqual(qq.policy, { id: pol.stable_id, version: 1, alcadaMi: null });
  assert.equal(qq.data.length, 4); // todo cenário com Investimento
  for (const it of qq.data) { assert.equal(it.alcadaMi, 0); assert.ok(validateAlcadaItem(it), JSON.stringify(validateAlcadaItem.errors)); }
  const ex = (await get(A, "/api/pulse/exceptions")).json.data;
  assert.ok(ex.some((e: { id: string }) => e.id === `alcada:misconfigured:${pol.stable_id}`));
  assert.equal(ex.filter((e: { source: string; action: string }) => e.source === "alcada" && e.action === "alcada_queue").length, 4);
  assert.equal((await decide(ASales, { scenario_id: low.id, run_id: low.run, action: "approve", why: "ok" })).json.error, "alcada_finance_required");

  await q("UPDATE policies SET body = '{\"limitMi\": 10}' WHERE stable_id = $1", [pol.stable_id]);
  qq = (await get(A, "/api/alcada/queue")).json;
  assert.equal(qq.mode, "active"); assert.equal(qq.policy.alcadaMi, 10);
  assert.deepEqual(qq.data.map((i: { scenarioId: string }) => i.scenarioId).sort(), [high.id, unk.id, esc.id].sort());
  const hi = qq.data.find((i: { scenarioId: string }) => i.scenarioId === high.id);
  assert.deepEqual({ id: hi.id, impactMi: hi.impactMi, alcadaMi: hi.alcadaMi, status: hi.status, escalateTo: hi.escalateTo, runId: hi.runId, policyRef: hi.policyRef },
    { id: `AQ-${high.code}-v1`, impactMi: 20, alcadaMi: 10, status: "pending_finance", escalateTo: "finance", runId: high.run, policyRef: { id: pol.stable_id, version: 1 } });
  assert.equal(qq.data.find((i: { scenarioId: string }) => i.scenarioId === unk.id).impactMi, null);
  assert.equal((await get(A, "/api/pulse/summary")).json.data.pending.alcada, 3);

  // ≤ alçada: Sales aprova (fora da fila); evento v0.2 com snapshot
  const okLow = await decide(ASales, { scenario_id: low.id, run_id: low.run, action: "approve", why: "ok" });
  assert.equal(okLow.status, 201, JSON.stringify(okLow.json));
  assert.equal(okLow.json.data.impactMi, 5); assert.equal(okLow.json.data.alcadaMi, 10); assert.equal(okLow.json.data.escalateTo, null);

  // > alçada: Sales não aprova; escala → finance; owner não aprova escalado p/ finance; Finance aprova
  assert.equal((await decide(ASales, { scenario_id: high.id, run_id: high.run, action: "approve", why: LONG })).status, 403);
  assert.equal((await decide(ASales, { scenario_id: high.id, action: "escalate", why: LONG, escalate_to: "domain_owner" })).json.error, "invalid_escalate_to");
  const e1 = await decide(ASales, { scenario_id: high.id, run_id: high.run, action: "escalate", why: LONG, escalate_to: "finance" });
  assert.equal(e1.status, 201, JSON.stringify(e1.json));
  assert.ok(validateDecisionEvent(e1.json.data), JSON.stringify(validateDecisionEvent.errors));
  assert.deepEqual([e1.json.data.impactMi, e1.json.data.alcadaMi, e1.json.data.escalateTo], [20, 10, "finance"]);
  const persisted = (await get(A, `/api/decision-events/${e1.json.data.id}`)).json.data;
  assert.deepEqual(persisted, e1.json.data); // v0.2 persistido (payload do audit_log) e relido igual
  assert.equal((await get(A, "/api/alcada/queue?status=pending_finance")).json.data.find((i: { scenarioId: string }) => i.scenarioId === high.id).events.length, 1);
  assert.equal((await decide(A, { scenario_id: high.id, run_id: high.run, action: "approve", why: LONG })).json.error, "escalated_to_finance");
  const fa = await decide(AFin, { scenario_id: high.id, run_id: high.run, action: "approve", why: LONG });
  assert.equal(fa.status, 201, JSON.stringify(fa.json));
  const appr = (await get(A, "/api/alcada/queue?status=approved_finance")).json.data;
  assert.deepEqual(appr.map((i: { scenarioId: string }) => i.scenarioId), [high.id]);
  const a0 = appr[0] as { events: unknown[]; escalateTo: string | null };
  assert.ok(validateAlcadaItem(appr[0])); assert.equal(a0.events.length, 2); assert.equal(a0.escalateTo, null);

  // Finance escala p/ dono → escalated_owner; dono aprova (Task 7) e o status segue escalated_owner (decisão Finance manda)
  const fe = await decide(AFin, { scenario_id: unk.id, run_id: unk.run, action: "escalate", why: LONG });
  assert.equal(fe.json.data.escalateTo, "domain_owner");
  assert.equal((await decide(A, { scenario_id: unk.id, run_id: unk.run, action: "approve", why: LONG })).status, 201);
  const u = (await get(A, "/api/alcada/queue?status=escalated_owner")).json.data;
  assert.deepEqual(u.map((i: { scenarioId: string }) => i.scenarioId), [unk.id]); assert.equal(u[0].escalateTo, "domain_owner");

  // Sales escala esc → finance; nova versão antes da Finance → v1 stale, v2 pending
  await decide(ASales, { scenario_id: esc.id, run_id: esc.run, action: "escalate", why: LONG });
  await q("UPDATE scenarios SET version = 2 WHERE id = $1", [esc.id]);
  qq = (await get(A, "/api/alcada/queue")).json;
  const escItems = qq.data.filter((i: { scenarioId: string }) => i.scenarioId === esc.id);
  assert.deepEqual(escItems.map((i: { id: string; status: string }) => [i.id, i.status]),
    [[`AQ-${esc.code}-v2`, "pending_finance"], [`AQ-${esc.code}-v1`, "stale"]]);
  for (const it of qq.data) assert.ok(validateAlcadaItem(it), JSON.stringify(validateAlcadaItem.errors));
  const order = qq.data.map((i: { status: string }) => i.status); // abertos primeiro
  assert.ok(order.lastIndexOf("pending_finance") < order.indexOf("approved_finance"));
  assert.ok(order.indexOf("stale") > order.indexOf("approved_finance"));
  const fin = (await get(A, "/api/visoes/finance")).json.data;
  assert.deepEqual(fin.action, { kind: "alcada_queue", enabled: true, count: 1, disabledReason: null });
});

test("RLS cross-tenant: B nunca vê fila/exceções/eventos/planRef de A", async () => {
  const { A, B, ASales } = await tenants();
  await policy(A.tenantId, "alcada", { limitMi: 1 });
  const sc = await scenario(A.tenantId);
  await card(A.tenantId, sc, "Investimento", { impactMi: 9 });
  const nB = (await q("INSERT INTO nodes (tenant_id, code, name, node_type) VALUES ($1,'NA','NA','cd') RETURNING stable_id", [A.tenantId]))[0];
  await q("INSERT INTO node_capacity (tenant_id, node_id, capacity_t_month) VALUES ($1, $2, 10)", [A.tenantId, nB.stable_id]);
  await card(A.tenantId, sc, "Gap", {}, "gap", nB.stable_id);
  const r = await run(A.tenantId, sc, "feasible", { reasons: [{ rank: 1, kind: "custo", summary: "A only", refs: {}, severity: "warn" }], plan: { totals: { fillRate: 1 } } });
  assert.equal((await decide(ASales, { scenario_id: sc, run_id: r, action: "escalate", why: LONG })).status, 201);
  const aq = (await get(A, "/api/alcada/queue")).json;
  assert.equal(aq.data.length, 1); assert.equal(aq.data[0].events.length, 1);
  const bq = (await get(B, "/api/alcada/queue")).json;
  assert.deepEqual([bq.data, bq.mode], [[], "no_policy"]);
  const bs = (await get(B, "/api/pulse/summary")).json.data;
  assert.equal(bs.planRef.basis, "none"); assert.equal(bs.pending.alcada, 0);
  const bex = (await get(B, "/api/pulse/exceptions")).json.data;
  assert.ok(bex.every((e: { source: string; scenarioId: string | null }) => e.source === "readiness" && e.scenarioId === null));
  assert.equal((await get(B, "/api/visoes/finance")).json.data.cards.find((k: { key: string }) => k.key === "invest_mi").value, 0);
});

test("labels (PO+Deivid 2026-10-30): visões + board + aderência sempre string não vazia; pack e tenant kpi_labels vencem", async () => {
  const { A } = await tenants();
  const labels = async () => {
    const vs = await Promise.all(["sales", "supply", "finance"].map((l) => get(A, `/api/visoes/${l}`).then((r) => r.json.data)));
    const sum = (await get(A, "/api/pulse/summary")).json.data;
    const all = [...vs.flatMap((v) => [...v.cards, ...v.cross]), ...sum.kpis, sum.execution.adherence] as { key: string; label: unknown }[];
    for (const k of all) assert.ok(typeof k.label === "string" && k.label.trim().length > 0 && !k.label.includes("{"), `${k.key}: ${String(k.label)}`);
    return Object.fromEntries(all.map((k) => [k.key, k.label as string]));
  };
  let L = await labels(); // sem linha em tenant_settings → generic
  assert.deepEqual([L.svc, L.demand_3p, L.util_avg], ["OTIF", "Demanda dos últimos 3 períodos", "Utilização média de armazenagem"]);
  const r = await call(A, "POST", "/api/cadastro/pack", { pack: "retail", why: "teste labels" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  L = await labels();
  assert.deepEqual([L.svc, L.util_avg], ["Fill rate", "Utilização média de área de estoque"]); // pack retail: kpi + entity_labels.capacity
  await q("UPDATE tenant_settings SET kpi_labels = kpi_labels || '{\"nodes_n\":\"Lojas ativas\",\"util_avg\":\"Ocupação média\"}' WHERE tenant_id = $1", [A.tenantId]);
  L = await labels();
  assert.deepEqual([L.nodes_current, L.util_avg, L.svc], ["Lojas ativas", "Ocupação média", "Fill rate"]);
});
