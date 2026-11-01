// W2 · Wizard API (W2-WIZARD-API-CONTRACT.md) — LLM SEMPRE mock (sem rede).
// Qualidade: empty unlock · ditado mock · invalid_reference · happy → A4 run · cache · 502 · RLS.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { createApp } from "../../src/http/app.js";
import { makePool } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import type { DitadoLlm } from "../../src/wizard/ditado.js";
import { toContractCard } from "../../src/wizard/cards.js";
import { setupTwoTenants } from "./helpers.js";
import { validatePremiseCard } from "../support/schemas.js";

const pool = makePool(env.databaseUrl);
type Who = { tenantId: string; adminUserId: string };
let A: Who, B: Who;
const servers: { close(): void }[] = [];
let base = "", baseDown = "", baseNone = "";

let llmCalls = 0;
let nextOutput: unknown = null;
const mockLlm: DitadoLlm = { async extract() { llmCalls++; return structuredClone(nextOutput); } };
const failingLlm: DitadoLlm = { async extract() { throw new Error("boom"); } };

async function listen(app: ReturnType<typeof createApp>) {
  const s = app.listen(0); servers.push(s);
  await new Promise((r) => s.once("listening", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
async function call(who: Who, method: string, path: string, body?: unknown, at = base) {
  const res = await fetch(at + path, {
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
/** rede mínima não-block: 2 CDs com capacidade, 2 lojas, rotas, SKU, demanda, políticas. */
async function seedNetwork(who: Who) {
  const node = (code: string) => ok(who, "POST", "/api/nodes", { code, name: code, node_type: "outro" });
  const [cd1, cd2, l1, l2] = [await node("CD1"), await node("CD2"), await node("L1"), await node("L2")];
  await ok(who, "POST", "/api/node_capacity", { node_id: cd1.stable_id, capacity_per_period: 100 });
  await ok(who, "POST", "/api/node_capacity", { node_id: cd2.stable_id, capacity_per_period: 50 });
  const route = (code: string, o: { stable_id: string }, d: { stable_id: string }) =>
    ok(who, "POST", "/api/routes", { code, origin_node_id: o.stable_id, dest_node_id: d.stable_id, cost_per_unit: 2, lead_time_days: 1 });
  await route("R1", cd1, l1); await route("R2", cd2, l1); await route("R3", cd1, l2); await route("R4", cd2, l2);
  const s1 = await ok(who, "POST", "/api/skus", { code: "S1", name: "S1" });
  await ok(who, "POST", "/api/policies", { kind: "Serviço", name: "svc", body: { min_fill_rate: 0.9, max_lead_time_days: 3 } });
  await ok(who, "POST", "/api/policies", { kind: "estoque", name: "est", body: {} });
  await ok(who, "POST", "/api/sales_history", { rows: [
    { node_id: l1.stable_id, sku_id: s1.stable_id, period: "2026-10", qty: 60 },
    { node_id: l2.stable_id, sku_id: s1.stable_id, period: "2026-10", qty: 50 }] });
  return { cd1, cd2, l1, l2 };
}
async function waitDone(who: Who, id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await call(who, "GET", `/api/a4-runs/${id}`);
    if (r.json.data.status === "done" || r.json.data.status === "failed") return r.json.data;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("run não terminou");
}
async function ownerQuery(sql: string, params: unknown[]) {
  const c = new pg.Client({ connectionString: env.migrationDatabaseUrl });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

before(async () => {
  const t = await setupTwoTenants();
  A = { tenantId: t.a.tenantId, adminUserId: t.a.adminUserId };
  B = { tenantId: t.b.tenantId, adminUserId: t.b.adminUserId };
  base = await listen(createApp(pool, { ditadoLlm: mockLlm }));
  baseDown = await listen(createApp(pool, { ditadoLlm: failingLlm }));
  baseNone = await listen(createApp(pool, { ditadoLlm: null }));
});
after(async () => { for (const s of servers) s.close(); await pool.end(); });

let scn = "";
let net: Awaited<ReturnType<typeof seedNetwork>>;

test("unlock: empty/unconfirmed tenant → 403 scenario_locked; confirmed but readiness block → 409 a4_not_ready", async () => {
  const locked = await call(A, "POST", "/api/scenarios", { name: "Abrir filial" });
  assert.equal(locked.status, 403, JSON.stringify(locked.json));
  assert.equal(locked.json.error, "scenario_locked");
  await ok(A, "PUT", "/api/tenant-settings", { confirmed: true });
  const block = await call(A, "POST", "/api/scenarios", { name: "Abrir filial" });
  assert.equal(block.status, 409, JSON.stringify(block.json));
  assert.equal(block.json.error, "a4_not_ready");
  assert.equal((await call(A, "GET", "/api/scenarios")).json.count, 0, "nada criado");
});

test("create draft v1 (SCN-NNNN), list current, get with cards; validation; B isolated", async () => {
  net = await seedNetwork(A);
  const r = await call(A, "POST", "/api/scenarios", { name: "Abrir filial", leg: "composed" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.data.code, r.json.data.version, r.json.data.status, r.json.data.leg, r.json.data.is_current],
    ["SCN-0001", 1, "draft", "composed", true]);
  scn = r.json.data.id;
  assert.equal((await ok(A, "POST", "/api/scenarios", { name: "Outro" })).code, "SCN-0002");
  assert.equal((await call(A, "POST", "/api/scenarios", { name: "" })).status, 400);
  assert.equal((await call(A, "POST", "/api/scenarios", { name: "x", leg: "marketing" })).status, 400);
  assert.equal((await call(A, "POST", "/api/scenarios", { name: "x", version: 9 })).status, 400, "strict");
  const list = await call(A, "GET", "/api/scenarios");
  assert.equal(list.json.count, 2);
  const one = await ok(A, "GET", `/api/scenarios/${scn}`);
  assert.deepEqual(one.cards, []);
  const audit = await ownerQuery("SELECT action FROM audit_log WHERE entity = 'scenarios' AND entity_id = $1", [scn]);
  assert.deepEqual(audit.map((a) => a.action), ["create"]);
  // B: não vê o cenário de A; seu próprio create segue travado (não confirmado)
  assert.equal((await call(B, "GET", `/api/scenarios/${scn}`)).status, 404);
  assert.equal((await call(B, "GET", "/api/scenarios")).json.count, 0);
  assert.equal((await call(B, "POST", "/api/scenarios", { name: "x" })).json.error, "scenario_locked");
});

test("ditado (mock) → typed cards source=ditado, Gap links.nodeId = stable_id; invalid NOT persisted; cache", async () => {
  nextOutput = { cards: [
    { type: "NovaFilial", fields: { nome: "Filial nova", similarA: "L1", porte: "M" }, nodeRef: "FL-NOVA" }, // nó ainda não existe
    { type: "CurvaDemanda", fields: { perfil: "natural", rampUpMeses: 9 }, nodeRef: "L1" },
    { type: "Investimento", fields: { capex: 4200000 } },
    { type: "Gap", fields: { descricao: "Falta capacidade no CD2" }, nodeRef: "cd2" },          // code → stable_id
    { type: "Gap", fields: { descricao: "nó inexistente" }, nodeRef: "NOPE" },                 // → invalid_reference
    { type: "Gap", fields: { descricao: "sem nó" } },                                          // → invalid_reference
    { type: "Promocao", fields: {} },                                                         // tipo fora do contrato
    { type: "Investimento", fields: { nested: { a: 1 } } },                                    // fields não escalar
  ] };
  const text = "Abrir filial porte semelhante à L1, curva natural, investimento 4,2 mi.";
  const r = await call(A, "POST", `/api/scenarios/${scn}/ditado`, { text });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(llmCalls, 1);
  assert.equal(r.json.cached, false);
  const cards = r.json.data as Record<string, any>[];
  assert.deepEqual(cards.map((c) => c.type), ["NovaFilial", "CurvaDemanda", "Investimento", "Gap"]);
  for (const c of cards) {
    assert.equal(c.source, "ditado"); assert.equal(c.version, 1);
    assert.ok(validatePremiseCard(toContractCard(c)), JSON.stringify(validatePremiseCard.errors));
  }
  assert.equal(cards[3].links.nodeId, net.cd2.stable_id);
  assert.equal(cards[3].status, "gap");
  assert.equal(cards[1].links.nodeId, net.l1.stable_id);
  assert.equal(cards[0].links.nodeId, null);
  assert.equal(cards[0].fields.nodeRef, "FL-NOVA");
  assert.deepEqual(cards.map((c) => c.card_id), ["PC-0001-01", "PC-0001-02", "PC-0001-03", "PC-0001-04"]);
  assert.deepEqual((r.json.rejected as { index: number; reason: string }[]).map((x) => [x.index, x.reason]),
    [[4, "invalid_reference"], [5, "invalid_reference"], [6, "validation_failed"], [7, "validation_failed"]]);
  const got = await ok(A, "GET", `/api/scenarios/${scn}`);
  assert.equal(got.cards.length, 4, "inválidos não persistem");

  // cache por (tenant, texto normalizado): não chama o LLM de novo
  const again = await call(A, "POST", `/api/scenarios/${scn}/ditado`, { text: `  ${text.toUpperCase()} ` });
  assert.equal(again.status, 201);
  assert.equal(again.json.cached, true);
  assert.equal(llmCalls, 1);
  // A1 (T-A1-ENG H4): CurvaDemanda v1 repetida no mesmo cenário (mesmo alvo/âncora/sku) → rejected duplicate_curve
  assert.deepEqual((again.json.rejected as { index: number; reason: string }[]).filter((x) => x.index === 1).map((x) => x.reason), ["duplicate_curve"]);
  assert.equal(again.json.data.length, 3);
  // tenant diferente, mesmo texto → não usa o cache de A (e B não vê cenário de A → 404 antes do LLM)
  assert.equal((await call(B, "POST", `/api/scenarios/${scn}/ditado`, { text })).status, 404);
  assert.equal(llmCalls, 1);
});

test("ditado errors: empty text 400 · only-invalid 422 (nothing persisted) · LLM fail/not configured → 502", async () => {
  const before = (await ok(A, "GET", `/api/scenarios/${scn}`)).cards.length;
  assert.equal((await call(A, "POST", `/api/scenarios/${scn}/ditado`, { text: "   " })).status, 400);
  nextOutput = { cards: [{ type: "Gap", fields: {}, nodeRef: "NOPE" }] };
  const none = await call(A, "POST", `/api/scenarios/${scn}/ditado`, { text: "só gap inválido" });
  assert.equal(none.status, 422, JSON.stringify(none.json));
  assert.equal(none.json.error, "ditado_no_cards");
  nextOutput = "not json object";
  assert.equal((await call(A, "POST", `/api/scenarios/${scn}/ditado`, { text: "saida quebrada" })).status, 422);
  const down = await call(A, "POST", `/api/scenarios/${scn}/ditado`, { text: "qualquer" }, baseDown);
  assert.equal(down.status, 502);
  assert.deepEqual([down.json.error, down.json.details.reason], ["ditado_unavailable", "provider_error"]);
  const unconf = await call(A, "POST", `/api/scenarios/${scn}/ditado`, { text: "qualquer" }, baseNone);
  assert.deepEqual([unconf.status, unconf.json.details.reason], [502, "not_configured"]);
  assert.equal((await ok(A, "GET", `/api/scenarios/${scn}`)).cards.length, before, "nada persistido");
});

test("cards under scenario: Gap needs links.nodeId of CURRENT node (missing/retired/version-row/cross-tenant → invalid_reference)", async () => {
  const p = `/api/scenarios/${scn}/premise_cards`;
  const gap = { type: "Gap", status: "gap", fields: { descricao: "x" } };
  for (const body of [gap, { ...gap, links: { nodeId: null } }]) {
    const r = await call(A, "POST", p, body);
    assert.deepEqual([r.status, r.json.error], [400, "invalid_reference"], JSON.stringify(body));
  }
  const n = await ok(A, "POST", "/api/nodes", { code: "RET", name: "ret", node_type: "outro" });
  const v2 = await ok(A, "PATCH", `/api/nodes/${n.id}`, { name: "ret v2", why: "rename" });
  assert.equal((await call(A, "POST", p, { ...gap, links: { nodeId: v2.id } })).json.error, "invalid_reference", "id de linha-versão");
  assert.equal((await call(A, "DELETE", `/api/nodes/${v2.id}`, { why: "fechou" })).status, 204);
  assert.equal((await call(A, "POST", p, { ...gap, links: { nodeId: n.stable_id } })).json.error, "invalid_reference", "aposentado");
  const nB = await ok(B, "POST", "/api/nodes", { code: "BN", name: "b", node_type: "outro" });
  assert.equal((await call(A, "POST", p, { ...gap, links: { nodeId: nB.stable_id } })).json.error, "invalid_reference", "cross-tenant");
  assert.equal((await call(A, "POST", p, { ...gap, links: { nodeId: net.cd1.stable_id }, node_id: net.cd2.stable_id })).status, 400, "conflito");
  const okCard = await call(A, "POST", p, { ...gap, links: { nodeId: net.cd1.stable_id } });
  assert.equal(okCard.status, 201, JSON.stringify(okCard.json));
  assert.deepEqual([okCard.json.data.links.nodeId, okCard.json.data.source, okCard.json.data.card_id], [net.cd1.stable_id, "edit", "PC-0001-08"]); // A1: re-ditado sem a curva duplicada (−1)
  assert.ok(validatePremiseCard(toContractCard(okCard.json.data)));
  // B não cria card no cenário de A
  assert.equal((await call(B, "POST", p, { ...gap, links: { nodeId: nB.stable_id } })).status, 404);
});

test("PATCH card: version bump, source=edit, audit; Gap can't drop node; happy path → A4 run done", async () => {
  const gapCard = (await ok(A, "GET", `/api/scenarios/${scn}`)).cards.find((c: { type: string; source: string }) => c.type === "Gap" && c.source === "ditado");
  const p = await call(A, "PATCH", `/api/premise_cards/${gapCard.id}`,
    { fields: { ...gapCard.fields, disponivel: "+40/mês" }, links: { nodeId: net.cd1.stable_id }, why: "ajuste no wizard" });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.deepEqual([p.json.data.version, p.json.data.source, p.json.data.links.nodeId], [2, "edit", net.cd1.stable_id]);
  assert.ok(validatePremiseCard(toContractCard(p.json.data)));
  const drop = await call(A, "PATCH", `/api/premise_cards/${gapCard.id}`, { links: { nodeId: null }, why: "x" });
  assert.deepEqual([drop.status, drop.json.error], [400, "invalid_reference"]);
  assert.equal((await call(A, "PATCH", `/api/premise_cards/${gapCard.id}`, { source: "ditado", why: "x" })).status, 400, "edit só source=edit");
  const audit = await ownerQuery(
    "SELECT action, payload FROM audit_log WHERE entity = 'premise_cards' AND entity_id = $1 ORDER BY at", [gapCard.id]);
  const upd = audit.find((a) => a.action === "update");
  assert.ok(upd, JSON.stringify(audit));
  assert.deepEqual([upd.payload.previous_version, upd.payload.version, upd.payload.previous_source, upd.payload.source, upd.payload.why],
    [1, 2, "ditado", "edit", "ajuste no wizard"]);

  const run = await call(A, "POST", "/api/a4-runs", { scenario_id: scn, time_limit_ms: 3000 });
  assert.equal(run.status, 202, JSON.stringify(run.json));
  const done = await waitDone(A, run.json.data.id);
  assert.equal(done.status, "done", JSON.stringify(done.error));
  assert.equal(done.summary.scenarioId, scn);
  assert.equal(done.summary.scenarioVersion, 1);
});
