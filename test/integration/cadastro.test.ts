// W3b · Task 9 — Cadastro write API (pack + alçada em tenant_settings). DoD do contrato W3B. Fixtures via owner; API via app (RLS).
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { createApp } from "../../src/http/app.js";
import { makePool } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import { ownerCreateScenario, setupTwoTenants } from "./helpers.js";
import { validateAlcadaItem } from "../support/schemas.js";

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
const get = (who: Who, path: string) => call(who, "GET", path);
const q = (sql: string, p: unknown[] = []) => owner.query(sql, p).then((r) => r.rows);
const code = (p = "W3B") => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const LONG = "Aprovo: investimento justificado pelo ganho de serviço.";
const settings = async (who: Who) => (await get(who, "/api/tenant-settings")).json.data;
const queue = async (who: Who) => (await get(who, "/api/alcada/queue")).json;
const pack = (who: Who, id: string, why = `troca p/ ${id}`) => call(who, "POST", "/api/cadastro/pack", { pack: id, why });
const alcada = (who: Who, limitMi: unknown, why = "limiar Finance") => call(who, "PUT", "/api/cadastro/alcada", { limitMi, why });
const curAlcada = (tenantId: string) =>
  q("SELECT stable_id, version, kind, name, body FROM policies WHERE tenant_id = $1 AND is_current AND kind IN ('alcada','alcada_finance')", [tenantId]);

async function tenants() {
  const t = await setupTwoTenants();
  const user = async (tenantId: string, role: string) =>
    (await q("INSERT INTO users (tenant_id, email, role) VALUES ($1, $2, $3) RETURNING id", [tenantId, `${role}-${code()}@t.test`, role]))[0].id as string;
  const A = { tenantId: t.a.tenantId, userId: t.a.adminUserId };
  return { A, B: { tenantId: t.b.tenantId, userId: t.b.adminUserId },
    ASales: { tenantId: A.tenantId, userId: await user(A.tenantId, "sales") },
    AFin: { tenantId: A.tenantId, userId: await user(A.tenantId, "finance") } };
}
/** Cenário com cartão Investimento (impactMi) + run feasible posterior → aprovável. */
async function invScenario(tenantId: string, impactMi: number) {
  const sc = await ownerCreateScenario(tenantId, code("SC"));
  await q(`INSERT INTO premise_cards (tenant_id, scenario_id, card_id, type, fields, status, source, created_at)
           VALUES ($1,$2,$3,'Investimento',$4,'ok','edit', now() - interval '10 seconds')`, [tenantId, sc, code("PC"), JSON.stringify({ impactMi })]);
  const run = (await q(`INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status, reasons, counts_by_kind, plan, started_at, finished_at)
           VALUES ($1,$2,$3,1,'feasible','[]','{}','{}', now() - interval '5 seconds', now() - interval '5 seconds') RETURNING id`,
    [tenantId, code("R"), sc]))[0].id as string;
  return { sc, run };
}
const approve = (who: Who, s: { sc: string; run: string }) =>
  call(who, "POST", "/api/decision-events", { scenario_id: s.sc, run_id: s.run, action: "approve", why: LONG });

before(async () => {
  await owner.connect();
  server = createApp(pool).listen(0);
  await new Promise<void>((r) => (server as unknown as { once(e: string, f: () => void): void }).once("listening", r));
  base = `http://127.0.0.1:${((server as unknown as { address(): AddressInfo }).address()).port}`;
});
after(async () => { server.close(); await owner.end(); await pool.end(); });

test("0013: colunas + CHECKs; zero grant novo (ibp_app usa grants da 0004)", async () => {
  const cols = (await q(`SELECT column_name, is_nullable, column_default FROM information_schema.columns
     WHERE table_name = 'tenant_settings' AND column_name IN ('industry_pack','entity_labels','policy_kinds','agent_roster') ORDER BY 1`));
  assert.deepEqual(cols.map((c) => [c.column_name, c.is_nullable]),
    [["agent_roster", "NO"], ["entity_labels", "NO"], ["industry_pack", "YES"], ["policy_kinds", "NO"]]);
  const cons = (await q("SELECT conname FROM pg_constraint WHERE conrelid = 'tenant_settings'::regclass AND conname LIKE 'tenant_settings_%' ORDER BY 1")).map((r) => r.conname);
  assert.ok(cons.includes("tenant_settings_pack_nonempty") && cons.includes("tenant_settings_jsonb_objects"));
  const { A } = await tenants();
  await q("INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", [A.tenantId]);
  await assert.rejects(q("UPDATE tenant_settings SET industry_pack = '  ' WHERE tenant_id = $1", [A.tenantId]), /pack_nonempty/);
  await assert.rejects(q("UPDATE tenant_settings SET policy_kinds = '[]' WHERE tenant_id = $1", [A.tenantId]), /jsonb_objects/);
  const g = (await q(`SELECT privilege_type FROM information_schema.role_table_grants
     WHERE grantee = 'ibp_app' AND table_name = 'tenant_settings' ORDER BY 1`)).map((r) => r.privilege_type);
  assert.deepEqual(g, ["INSERT", "SELECT", "UPDATE"]);
});

test("GET /cadastro/packs = 5; generic_no_alcada sem alçada, demais com default 2; tenant-settings sem linha → defaults + alcada no_policy", async () => {
  const { A } = await tenants();
  const ps = (await get(A, "/api/cadastro/packs")).json.data;
  assert.equal(ps.length, 5);
  for (const p of ps) {
    assert.deepEqual(Object.keys(p).sort(), ["agents", "alcadaDefaultMi", "id", "includesAlcada", "labels", "name", "policy_kinds", "sim"]);
    assert.equal(p.includesAlcada, p.id !== "generic_no_alcada");
    assert.equal(p.alcadaDefaultMi, p.includesAlcada ? 2 : null);
  }
  assert.equal((await call(null, "GET", "/api/cadastro/packs")).status, 401);
  const s = await settings(A);
  assert.equal(s.industry_pack, null);
  assert.deepEqual([s.entity_labels, s.policy_kinds, s.agent_roster], [{}, {}, {}]);
  assert.deepEqual(s.alcada, { inPack: true, mode: "no_policy", policy: null }); // cravo 1: NULL ≡ generic → fail-closed
});

test("POST /pack: aplica seed; currency/confirmed_at intactos; node_types ⊇ em uso; overrides descartados; cria alçada 2; audit; 400s", async () => {
  const { A } = await tenants();
  assert.equal((await call(A, "PUT", "/api/tenant-settings", { currency: "BRL", confirmed: true,
    entity_labels: { node: "Galpão", capacity: "m²", route: "Trecho", sku: "Item", contract: "Acordo" } })).status, 200);
  const before = await settings(A);
  await q("INSERT INTO nodes (tenant_id, code, name, node_type) VALUES ($1, $2, 'Legado', 'Armazém X')", [A.tenantId, code("N")]);
  assert.equal((await call(A, "POST", "/api/cadastro/pack", { pack: "nope", why: "x" })).json.error, "invalid_pack");
  assert.equal((await call(A, "POST", "/api/cadastro/pack", { pack: "oilgas" })).status, 400); // why obrigatório
  assert.equal((await call({ ...A, userId: null }, "POST", "/api/cadastro/pack", { pack: "oilgas", why: "x" })).status, 401);
  const r = await pack(A, "oilgas", "Distribuidora de combustíveis");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const d = r.json.data;
  assert.equal(d.industry_pack, "oilgas");
  assert.equal(d.entity_labels.node, "Terminal"); // override "Galpão" descartado
  assert.equal(d.entity_labels.capacity_uom, "m³");
  assert.equal(d.uom, "L"); assert.equal(d.kpi_labels.wcp, "DIO");
  assert.deepEqual(d.policy_kinds.alcada, ["alcada", "alcada_finance"]);
  assert.ok(d.policy_kinds.inventory.includes("estoque_tancado"));
  assert.deepEqual(d.agent_roster.A6, { enabled: true }); assert.equal(d.agent_roster.A4.solver, "cbc");
  assert.equal(d.currency, "BRL"); assert.equal(d.confirmed_at, before.confirmed_at);
  assert.deepEqual(d.node_types, ["Terminal", "Base", "Refinaria", "Armazém X"]);
  assert.deepEqual(r.json.alcadaEffect.action, "created");
  assert.deepEqual([d.alcada.inPack, d.alcada.mode, d.alcada.policy.alcadaMi, d.alcada.policy.version], [true, "active", 2, 1]);
  const pol = await curAlcada(A.tenantId);
  assert.deepEqual([pol.length, pol[0].kind, pol[0].name], [1, "alcada", "Alçada Finance investimento"]);
  const au = await q("SELECT payload FROM audit_log WHERE tenant_id = $1 AND entity = 'tenant_settings' AND payload->>'action' = 'apply_pack'", [A.tenantId]);
  assert.deepEqual([au[0].payload.why, au[0].payload.from, au[0].payload.to], ["Distribuidora de combustíveis", null, "oilgas"]);
  // readiness usa policy_kinds do tenant: alias do pack conta
  await q("INSERT INTO policies (tenant_id, kind, name, body) VALUES ($1, 'capital_giro_produto', 'WC', '{}')", [A.tenantId]);
  const rd = (await get(A, "/api/a4-readiness")).json.data;
  assert.equal(rd.items.find((i: { key: string }) => i.key === "policy").status, "ok");
});

test("alçada × pack: com POL mantém limiar · → generic_no_alcada retira (out_of_pack, Sales aprova) · volta → revive com 2", async () => {
  const { A, ASales } = await tenants();
  await pack(A, "cpg");
  assert.equal((await alcada(A, 7)).status, 200);
  const k = await pack(A, "retail");
  assert.equal(k.json.alcadaEffect.action, "kept");
  assert.equal(k.json.data.alcada.policy.alcadaMi, 7);
  const sid = (await curAlcada(A.tenantId))[0].stable_id;
  const inv = await invScenario(A.tenantId, 50);
  const off = await pack(A, "generic_no_alcada", "sem gate Finance");
  assert.deepEqual([off.json.alcadaEffect.action, off.json.alcadaEffect.policyIds], ["retired", [sid]]);
  assert.deepEqual(off.json.data.alcada, { inPack: false, mode: "out_of_pack", policy: null });
  assert.equal((await curAlcada(A.tenantId)).length, 0);
  assert.ok((await q("SELECT 1 FROM policies WHERE stable_id = $1", [sid])).length >= 2); // histórico preservado
  const qq = await queue(A);
  assert.deepEqual([qq.data, qq.mode, qq.nextStep], [[], "out_of_pack", null]); assert.match(qq.notice, /fora do pack/);
  const fin = (await get(A, "/api/visoes/finance")).json.data.action;
  assert.equal(fin.disabledReason, "out_of_pack");
  assert.equal((await approve(ASales, inv)).status, 201); // único fail-open
  assert.equal((await pack(A, "generic_no_alcada")).json.alcadaEffect.action, "none");
  const back = await pack(A, "generic");
  assert.equal(back.json.alcadaEffect.action, "created");
  assert.deepEqual([back.json.alcadaEffect.policyIds[0], back.json.data.alcada.mode, back.json.data.alcada.policy.alcadaMi], [sid, "active", 2]);
});

test("PUT /cadastro/alcada: cria · nova versão · null → misconfigured · string → 400 · fora do pack → packSwitched generic + fail-closed", async () => {
  const { A, ASales, AFin } = await tenants();
  assert.equal((await alcada(A, "2")).json.error, "invalid_limit_mi");
  assert.equal((await alcada(A, -1)).json.error, "invalid_limit_mi");
  assert.equal((await call(A, "PUT", "/api/cadastro/alcada", { why: "x" })).json.error, "invalid_limit_mi");
  assert.equal((await call(A, "PUT", "/api/cadastro/alcada", { limitMi: 1 })).status, 400); // why
  const c1 = await alcada(A, 5);
  assert.deepEqual([c1.json.action, c1.json.policy.version, c1.json.policy.kind, c1.json.packSwitched], ["created", 1, "alcada", null]);
  const c2 = await alcada(A, 3, "aperta limiar");
  assert.deepEqual([c2.json.action, c2.json.policy.version, c2.json.policy.stable_id, c2.json.data.alcada.policy.alcadaMi],
    ["updated", 2, c1.json.policy.stable_id, 3]);
  const au = await q("SELECT payload FROM audit_log WHERE tenant_id = $1 AND entity = 'policies' AND action = 'update'", [A.tenantId]);
  assert.equal(au.at(-1).payload.why, "aperta limiar");
  const clr = await alcada(A, null, "limpar");
  assert.deepEqual([clr.json.data.alcada.mode, clr.json.data.alcada.policy.alcadaMi], ["misconfigured", null]);
  const inv = await invScenario(A.tenantId, 0.5);
  assert.equal((await approve(ASales, inv)).json.error, "alcada_finance_required"); // misconfigured fail-closed
  const qq = await queue(A);
  assert.equal(qq.nextStep.key, "publish_alcada");
  for (const it of qq.data) assert.ok(validateAlcadaItem(it), JSON.stringify(validateAlcadaItem.errors));
  // fora do pack → publicar = switch p/ generic
  await pack(A, "cpg"); await pack(A, "generic_no_alcada");
  const labels = (await settings(A)).entity_labels;
  const sw = await alcada(A, 1, "volta a exigir Finance");
  assert.deepEqual(sw.json.packSwitched, { from: "generic_no_alcada", to: "generic" });
  assert.equal(sw.json.data.industry_pack, "generic");
  assert.deepEqual(sw.json.data.policy_kinds.alcada, ["alcada", "alcada_finance"]);
  assert.deepEqual(sw.json.data.entity_labels, labels); // não re-aplica o pack inteiro
  assert.deepEqual([sw.json.data.alcada.mode, sw.json.data.alcada.policy.alcadaMi], ["active", 1]);
  const inv2 = await invScenario(A.tenantId, 4);
  assert.equal((await approve(ASales, inv2)).json.error, "alcada_finance_required"); // fail-closed na hora
  assert.equal((await approve(AFin, inv2)).status, 201);
  const sa = await q("SELECT payload FROM audit_log WHERE tenant_id = $1 AND payload->>'action' = 'pack_switch'", [A.tenantId]);
  assert.deepEqual([sa[0].payload.from, sa[0].payload.to, sa[0].payload.why], ["generic_no_alcada", "generic", "volta a exigir Finance"]);
});

test("Regra 5 no CRUD genérico: 409 alcada_exists · 409 alcada_required_in_pack · PATCH limitMi estrito · POST fora do pack → switch", async () => {
  const { A } = await tenants();
  const p = await call(A, "POST", "/api/policies", { kind: "Alçada", name: "Alçada A", body: { limitMi: 4 }, why: "publica" });
  assert.equal(p.status, 201, JSON.stringify(p.json));
  assert.equal((await settings(A)).alcada.mode, "active");
  const dup = await call(A, "POST", "/api/policies", { kind: "alcada", name: "Outra", body: { limitMi: 1 } });
  assert.deepEqual([dup.status, dup.json.error], [409, "alcada_exists"]);
  assert.equal((await call(A, "POST", "/api/policies", { kind: "alcada", name: "S", body: { limitMi: "abc" } })).json.error, "invalid_limit_mi");
  assert.equal((await call(A, "PATCH", `/api/policies/${p.json.data.id}`, { body: { limitMi: "abc" }, why: "x" })).json.error, "invalid_limit_mi");
  const pt = await call(A, "PATCH", `/api/policies/${p.json.data.id}`, { body: { limitMi: 9 }, why: "sobe" });
  assert.equal(pt.status, 200);
  const del = await call(A, "DELETE", `/api/policies/${pt.json.data.id}?why=remove`);
  assert.deepEqual([del.status, del.json.error], [409, "alcada_required_in_pack"]);
  // drift legado: 2 POL correntes → retire de uma é permitido; PUT acusa ambiguidade
  await q("INSERT INTO policies (tenant_id, kind, name, body) VALUES ($1, 'alcada', 'Drift', '{\"limitMi\": 1}')", [A.tenantId]);
  assert.equal((await alcada(A, 2)).json.error, "alcada_ambiguous");
  assert.equal((await call(A, "DELETE", `/api/policies/${pt.json.data.id}?why=drift`)).status, 204);
  // POL não-alçada passa direto
  assert.equal((await call(A, "POST", "/api/policies", { kind: "inventory", name: "Estoque", body: {} })).status, 201);
  // fora do pack: POST de alçada = publicar → switch p/ generic
  await pack(A, "generic_no_alcada");
  const sw = await call(A, "POST", "/api/policies", { kind: "alcada_finance", name: "Nova", body: { limitMi: 2 }, why: "form" });
  assert.equal(sw.status, 201, JSON.stringify(sw.json));
  assert.deepEqual(sw.json.packSwitched, { from: "generic_no_alcada", to: "generic" });
  assert.equal((await settings(A)).alcada.mode, "active");
});

test("PUT /tenant-settings: overrides validados (400s) · industry_pack/alcada só via pack · merge por chave · strict", async () => {
  const { A } = await tenants();
  const put = (b: unknown) => call(A, "PUT", "/api/tenant-settings", b);
  const L = { node: "Nó", capacity: "x", route: "Rota", sku: "SKU", contract: "Contrato" };
  assert.equal((await put({ industry_pack: "cpg" })).json.error, "use_pack_endpoint");
  assert.equal((await put({ entity_labels: { node: "Nó" } })).json.error, "invalid_labels");
  assert.equal((await put({ entity_labels: { ...L, extra: "x" } })).json.error, "invalid_labels");
  assert.equal((await put({ policy_kinds: { service: ["estoque"] } })).json.error, "ambiguous_policy_kind");
  assert.equal((await put({ policy_kinds: { capex: ["x"] } })).json.error, "invalid_policy_kinds");
  assert.equal((await put({ policy_kinds: { alcada: null } })).json.error, "use_pack_endpoint");
  assert.equal((await put({ agent_roster: { A4: { enabled: true, solver: "highs" } } })).json.error, "invalid_agent_roster");
  assert.equal((await put({ agent_roster: { A7: { enabled: true, mode: "llm" } } })).json.error, "invalid_agent_roster");
  assert.equal((await put({ foo: 1 })).json.error, "validation_failed");
  await pack(A, "generic_no_alcada");
  assert.equal((await put({ policy_kinds: { alcada: ["alcada"] } })).json.error, "use_pack_endpoint");
  const ok = await put({ entity_labels: { ...L, node: " Hub " }, policy_kinds: { inventory: ["Estoque", "Cobertura"] }, agent_roster: { A5: { enabled: true } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.data.entity_labels.node, "Hub");
  assert.deepEqual(ok.json.data.policy_kinds.inventory, ["estoque", "cobertura"]);
  assert.deepEqual(ok.json.data.policy_kinds.service, ["service", "servico", "service_level"]); // outras chaves intactas
  assert.equal("alcada" in ok.json.data.policy_kinds, false);
  assert.deepEqual([ok.json.data.agent_roster.A5, ok.json.data.agent_roster.A1], [{ enabled: true }, { enabled: true }]);
  assert.equal(ok.json.data.industry_pack, "generic_no_alcada");
  // legado {} materializa o vocabulário legado (inclui alcada) ao primeiro override
  const { A: L2 } = await tenants();
  const m = await call(L2, "PUT", "/api/tenant-settings", { policy_kinds: { inventory: ["lastro"] } });
  assert.deepEqual([m.json.data.policy_kinds.alcada, m.json.data.alcada.mode], [["alcada"], "no_policy"]);
});

test("Task 8 ajustada: no_policy fail-closed (403 Sales, exceção + nextStep publicar alçada); active libera; limiar não reabre passado", async () => {
  const { A, ASales } = await tenants();
  const inv = await invScenario(A.tenantId, 3);
  const r = await approve(ASales, inv);
  assert.deepEqual([r.status, r.json.error], [403, "alcada_finance_required"]);
  const qq = await queue(A);
  assert.deepEqual([qq.mode, qq.data, qq.needsPolicy, qq.nextStep.key], ["no_policy", [], 1, "publish_alcada"]);
  const ex = (await get(A, "/api/pulse/exceptions")).json.data;
  assert.ok(ex.some((e: { id: string; action: string }) => e.id === "alcada:no_policy" && e.action === "publish_alcada"));
  assert.equal((await get(A, "/api/visoes/finance")).json.data.action.disabledReason, "no_policy");
  await alcada(A, 10);
  const ok = await approve(ASales, inv);
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.data.alcadaMi, 10);
  await alcada(A, 1); // mudar limiar não reabre decisão passada
  const ev = (await get(A, `/api/decision-events?scenario_id=${inv.sc}`)).json;
  assert.equal(ev.data.length, 1); assert.equal(ev.data[0].alcadaMi, 10);
});

test("RLS: tenant B não lê nem escreve settings/POL de A", async () => {
  const { A, B } = await tenants();
  await pack(A, "oilgas");
  const aPol = (await curAlcada(A.tenantId))[0];
  const bs = await settings(B);
  assert.equal(bs.industry_pack, null);
  assert.equal(bs.alcada.policy, null);
  const aId = (await q("SELECT id FROM policies WHERE stable_id = $1 AND is_current", [aPol.stable_id]))[0].id;
  assert.equal((await call(B, "DELETE", `/api/policies/${aId}?why=x`)).status, 404);
  assert.equal((await call(B, "PATCH", `/api/policies/${aId}`, { body: { limitMi: 0 }, why: "x" })).status, 404);
  await alcada(B, 9);
  await pack(B, "generic_no_alcada");
  const after = await curAlcada(A.tenantId);
  assert.deepEqual([after.length, after[0].version, after[0].body], [1, aPol.version, aPol.body]);
  assert.equal((await settings(A)).industry_pack, "oilgas");
  const bt = await q("SELECT count(*)::int n FROM tenant_settings WHERE tenant_id = $1 AND industry_pack = 'generic_no_alcada'", [B.tenantId]);
  assert.equal(bt[0].n, 1);
});
