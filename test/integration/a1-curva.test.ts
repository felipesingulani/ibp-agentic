// A1 · CurvaDemanda v1 (A1-CURVA-DEMANDA-CONTRACT.md · QA-ACCEPTANCE-A1-CURVA.md) — LLM SEMPRE mock (sem rede).
// M1 hist→18 pts rastreável · M2 âncora inválida · M3 gaps tipados · M4 GET/PATCH recálculo · M5 isolamento + legado
// · H2 NovaFilial+Curva · H4 duplicate_curve · H5 a1_disabled. Sem endpoint novo (/ditado + premise_cards existentes).
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { createApp } from "../../src/http/app.js";
import { makePool } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import type { DitadoLlm } from "../../src/wizard/ditado.js";
import { toContractCard } from "../../src/wizard/cards.js";
import { buildCurva, resolveParams } from "../../src/wizard/curva.js";
import { ownerCreateScenario, setupTwoTenants } from "./helpers.js";
import { validatePremiseCard } from "../support/schemas.js";

const pool = makePool(env.databaseUrl);
type Who = { tenantId: string; adminUserId: string };
let A: Who, B: Who;
let server: { close(): void } | null = null;
let base = "";
let nextOutput: unknown = null;
let llmCalls = 0;
const mockLlm: DitadoLlm = { async extract() { llmCalls++; return structuredClone(nextOutput); } };

async function call(who: Who, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
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
async function owner(sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: env.migrationDatabaseUrl });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
const histCount = async () => Number((await owner("SELECT count(*)::int AS n FROM sales_history WHERE tenant_id = $1", [A.tenantId]))[0].n);
const months = (n: number, to = "2026-10") => { // n meses terminando em `to`, ascendente
  const [y, m] = to.split("-").map(Number); const t = y * 12 + m - 1;
  return Array.from({ length: n }, (_, i) => { const k = t - (n - 1 - i); return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`; });
};
const ditado = (who: Who, scn: string, text: string, cards: unknown[]) => { nextOutput = { cards }; return call(who, "POST", `/api/scenarios/${scn}/ditado`, { text }); };
const reasons = (r: { json: { rejected: { index: number; reason: string }[] } }) => r.json.rejected.map((x) => [x.index, x.reason]);

const net: Record<string, any> = {};
let scn = "", scnB = "";

before(async () => {
  const t = await setupTwoTenants();
  A = { tenantId: t.a.tenantId, adminUserId: t.a.adminUserId };
  B = { tenantId: t.b.tenantId, adminUserId: t.b.adminUserId };
  const s = createApp(pool, { ditadoLlm: mockLlm }).listen(0); server = s;
  await new Promise((r) => s.once("listening", r));
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const node = (who: Who, code: string) => ok(who, "POST", "/api/nodes", { code, name: code, node_type: "outro" });
  for (const code of ["ANC12", "ANC5", "ANC0", "FL1", "RET"]) net[code] = await node(A, code);
  net.S1 = await ok(A, "POST", "/api/skus", { code: "S1", name: "SKU 1" });
  net.S2 = await ok(A, "POST", "/api/skus", { code: "S2", name: "SKU 2" });
  // ANC12: 13 meses (só os 12 mais recentes entram); S2 só em 1 mês (filtro por SKU).
  // T-DM-PERIOD-GRAIN: linha diária (YYYY-MM-DD) não entra mais — rejeitada na borda (ver api.test.ts).
  const m13 = months(13);
  const rows = m13.map((p, i) => ({ node_id: net.ANC12.stable_id, sku_id: net.S1.stable_id, period: p, qty: 100 + i * 10 }));
  rows.push({ node_id: net.ANC12.stable_id, sku_id: net.S2.stable_id, period: "2026-10", qty: 7 });
  for (const p of months(5)) rows.push({ node_id: net.ANC5.stable_id, sku_id: net.S1.stable_id, period: p, qty: 40 });
  await ok(A, "POST", "/api/sales_history", { rows });
  await ok(A, "DELETE", `/api/nodes/${net.RET.id}`, { why: "aposentado (teste A1)" });
  net.BN = await node(B, "BN");
  net.BS = await ok(B, "POST", "/api/skus", { code: "BS", name: "b" });
  await ok(B, "POST", "/api/sales_history", { rows: months(12).map((p) => ({ node_id: net.BN.stable_id, sku_id: net.BS.stable_id, period: p, qty: 999 })) });
  scn = await ownerCreateScenario(A.tenantId, "A1-CURVA");
  scnB = await ownerCreateScenario(B.tenantId, "A1-CURVA-B");
});
after(async () => { server?.close(); await pool.end(); });

test("M1+H2: ditado → CurvaDemanda v1 ok, 18 pts derivados do hist seeded (série do LLM descartada) + NovaFilial; sales_history read-only", async () => {
  const before = await histCount();
  const r = await ditado(A, scn, "Filial nova semelhante à ANC12, curva linear 6 meses", [
    { type: "NovaFilial", fields: { nome: "Filial nova", similarA: "ANC12" }, nodeRef: "FL-NOVA" },
    { type: "CurvaDemanda", anchorRef: "anc12", skuRef: "S1", nodeRef: "FL1", status: "ok",
      fields: { perfil: "linear", rampUpMeses: 6, series: [{ period: "2026-11", qty: 1e9 }], qty: 1e9, extra: "x" } },
  ]);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(r.json.data.map((c: any) => c.type), ["NovaFilial", "CurvaDemanda"]);
  assert.deepEqual(r.json.rejected, []);
  const c = r.json.data[1];
  const f = c.fields;
  assert.equal(c.status, "ok"); assert.equal(c.source, "ditado"); assert.equal(c.links.nodeId, net.FL1.stable_id);
  assert.equal(f.schema, "a1.curva.v1"); assert.equal(f.gapCode, null);
  assert.equal(f.series.length, 18);
  assert.ok(f.series.every((p: any) => p.qty >= 0 && p.qty < 1e6), "série do LLM nunca persiste");
  assert.equal("qty" in f, false); assert.equal("extra" in f, false);
  assert.deepEqual(f.anchor, { nodeStableId: net.ANC12.stable_id, skuStableId: net.S1.stable_id, periodsUsed: 12 });
  // hist esperado: 12 meses mais recentes (2025-11..2026-10) de S1; S2 (7) fora
  const exp = months(12).map((m, i) => ({ m, qty: 110 + i * 10 }));
  const mean = Math.round((exp.reduce((s, h) => s + h.qty, 0) / 12) * 100) / 100;
  assert.deepEqual(f.trace, { method: "a1.curva.v1", histFrom: "2025-11", histTo: "2026-10", baseQty: mean, histSource: "sales_history" });
  assert.equal(f.series[0].period, "2026-11"); assert.equal(f.series[17].period, "2028-04");
  assert.equal(f.series[5].factor, 1); assert.equal(f.series[5].qty, mean); // linear: t=M=6 → P
  assert.equal(f.series[2].factor, 0.5);
  // determinismo: mesma função pura sobre o hist seeded = byte-idêntico ao persistido
  const again = buildCurva(exp, resolveParams({ perfil: "linear", rampUpMeses: 6 }));
  assert.deepEqual(again.series, f.series);
  assert.equal(JSON.stringify(buildCurva([...exp].reverse(), resolveParams({ perfil: "linear", rampUpMeses: 6 }))), JSON.stringify(again));
  assert.ok(validatePremiseCard(toContractCard(c)), JSON.stringify(validatePremiseCard.errors));
  assert.equal(await histCount(), before, "sales_history intocado");
  const aud = await owner("SELECT payload AS data FROM audit_log WHERE entity = 'premise_cards' AND entity_id = $1 AND action = 'create'", [c.id]);
  assert.equal(aud.length, 1);
  assert.deepEqual([aud[0].data.data.fields.anchor.nodeStableId, aud[0].data.data.fields.trace.histTo, "series" in aud[0].data.data.fields],
    [net.ANC12.stable_id, "2026-10", false]);
});

test("M3: 0 meses → hist_none · 5 meses → hist_insufficient (periodsUsed=5) · sem âncora → anchor_missing; series=[] sempre", async () => {
  const r = await ditado(A, scn, "curvas gap", [
    { type: "CurvaDemanda", anchorRef: "ANC0", fields: {} },
    { type: "CurvaDemanda", anchorRef: net.ANC5.stable_id, fields: { perfil: "degrau" } },
    { type: "CurvaDemanda", fields: { perfil: "natural" }, nodeRef: "FL-NOVA-2" },
  ]);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const [z, five, none] = r.json.data;
  assert.deepEqual([z.status, z.fields.gapCode, z.fields.series, z.fields.anchor.periodsUsed, z.fields.trace], ["gap", "hist_none", [], 0, null]);
  assert.deepEqual([five.status, five.fields.gapCode, five.fields.series, five.fields.anchor.periodsUsed], ["gap", "hist_insufficient", [], 5]);
  assert.deepEqual([five.fields.trace.histFrom, five.fields.trace.histTo, five.fields.trace.baseQty], ["2026-06", "2026-10", 40]);
  assert.deepEqual([none.status, none.fields.gapCode, none.fields.series, none.fields.anchor.nodeStableId], ["gap", "anchor_missing", [], null]);
  assert.equal(none.fields.nodeRef, "FL-NOVA-2"); assert.equal(none.links.nodeId, null);
  assert.deepEqual([z.fields.perfil, z.fields.rampUpMeses, z.fields.maturidade, z.fields.canibalizacao], ["natural", 9, { pct: 100, mes: 9 }, null]);
  for (const c of r.json.data) assert.ok(validatePremiseCard(toContractCard(c)), JSON.stringify(validatePremiseCard.errors));
});

test("M2: âncora/SKU inexistente · aposentada · cross-tenant → rejected invalid_reference (zero card)", async () => {
  const before = (await ok(A, "GET", `/api/scenarios/${scn}`)).cards.length;
  const r = await ditado(A, scn, "âncoras inválidas", [
    { type: "CurvaDemanda", anchorRef: "NOPE", fields: {} },
    { type: "CurvaDemanda", anchorRef: "RET", fields: {} },
    { type: "CurvaDemanda", anchorRef: "BN", fields: {} },
    { type: "CurvaDemanda", anchorRef: net.BN.stable_id, fields: {} },
    { type: "CurvaDemanda", anchorRef: "ANC12", skuRef: "BS", fields: {} },
    { type: "CurvaDemanda", anchorRef: "ANC12", fields: { rampUpMeses: 10, maturidade: { pct: 100, mes: 4 } } },
    { type: "Investimento", fields: { capex: 1 } },
  ]);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(reasons(r), [[0, "invalid_reference"], [1, "invalid_reference"], [2, "invalid_reference"], [3, "invalid_reference"],
    [4, "invalid_reference"], [5, "validation_failed"]]);
  assert.equal(r.json.rejected[0].detail.field, "fields.anchor.nodeStableId");
  assert.equal(r.json.rejected[4].detail.field, "fields.anchor.skuStableId");
  assert.equal((await ok(A, "GET", `/api/scenarios/${scn}`)).cards.length, before + 1, "só o Investimento persiste");
  // só-curva inválida → 422 (existente)
  const none = await ditado(A, scn, "só inválida", [{ type: "CurvaDemanda", anchorRef: "NOPE", fields: {} }]);
  assert.deepEqual([none.status, none.json.error], [422, "ditado_no_cards"]);
});

test("M4: GET reflete card+série · PATCH params recalcula (version+1, source=edit) · ok↔gap · derivados = 400 · âncora inválida = 400", async () => {
  const cards = (await ok(A, "GET", `/api/scenarios/${scn}`)).cards as any[];
  const c = cards.find((x) => x.fields?.schema === "a1.curva.v1" && x.status === "ok");
  assert.ok(c); assert.equal(c.fields.series.length, 18);
  const p = `/api/premise_cards/${c.id}`;
  assert.equal((await call(A, "PATCH", p, { fields: { rampUpMeses: 12 } })).status, 400, "why obrigatório");
  for (const [fields, field] of [[{ series: [] }, "fields.series"], [{ trace: null }, "fields.trace"], [{ gapCode: null }, "fields.gapCode"],
    [{ uom: "kg" }, "fields.uom"], [{ anchor: { periodsUsed: 12 } }, "fields.anchor.periodsUsed"]] as const) {
    const r = await call(A, "PATCH", p, { fields, why: "x" });
    assert.deepEqual([r.status, r.json.error, r.json.details.field], [400, "validation_failed", field], JSON.stringify(fields));
  }
  const st = await call(A, "PATCH", p, { status: "gap", why: "x" });
  assert.deepEqual([st.status, st.json.error], [400, "validation_failed"]);
  const bad = await call(A, "PATCH", p, { fields: { perfil: "exponencial" }, why: "x" });
  assert.deepEqual([bad.status, bad.json.error], [400, "validation_failed"]);
  for (const nodeStableId of [net.BN.stable_id, net.RET.stable_id, "not-a-uuid"]) {
    const r = await call(A, "PATCH", p, { fields: { anchor: { nodeStableId } }, why: "x" });
    assert.deepEqual([r.status, r.json.error], [400, "invalid_reference"], nodeStableId);
  }
  const e1 = await ok(A, "PATCH", p, { fields: { rampUpMeses: 12 }, why: "ramp maior" });
  assert.deepEqual([e1.version, e1.source, e1.status, e1.fields.rampUpMeses, e1.fields.maturidade.mes], [c.version + 1, "edit", "ok", 12, 12]);
  assert.notDeepEqual(e1.fields.series, c.fields.series);
  assert.equal(e1.fields.series[5].factor, 0.5); // linear M=12, t=6
  assert.equal(e1.fields.perfil, "linear", "params não editados preservados");
  const e2 = await ok(A, "PATCH", p, { fields: { anchor: { nodeStableId: net.ANC5.stable_id, skuStableId: null } }, why: "âncora 5m" });
  assert.deepEqual([e2.version, e2.status, e2.fields.gapCode, e2.fields.series, e2.fields.anchor.periodsUsed], [c.version + 2, "gap", "hist_insufficient", [], 5]);
  const e3 = await ok(A, "PATCH", p, { fields: { anchor: { nodeStableId: net.ANC12.stable_id, skuStableId: net.S1.stable_id } }, why: "volta" });
  assert.deepEqual([e3.status, e3.fields.series.length], ["ok", 18]);
  assert.ok(validatePremiseCard(toContractCard(e3)));
  const got = ((await ok(A, "GET", `/api/scenarios/${scn}`)).cards as any[]).find((x) => x.id === c.id);
  assert.deepEqual([got.version, got.fields.series], [e3.version, e3.fields.series]);
  const aud = await owner("SELECT payload AS data FROM audit_log WHERE entity = 'premise_cards' AND entity_id = $1 AND action = 'update' ORDER BY id", [c.id]);
  assert.equal(aud.length, 3);
  assert.deepEqual([aud[0].data.why, aud[0].data.changes.fields.trace.method, "series" in aud[0].data.changes.fields], ["ramp maior", "a1.curva.v1", false]);
});

test("POST manual v1: mesma derivação (cliente não injeta série/status); mes < ramp = 400", async () => {
  const p = `/api/scenarios/${scn}/premise_cards`;
  const ins = await call(A, "POST", p, { type: "CurvaDemanda", fields: { schema: "a1.curva.v1", perfil: "natural", rampUpMeses: 9,
    anchor: { nodeStableId: net.ANC12.stable_id } }, links: { nodeId: null } });
  assert.equal(ins.status, 201, JSON.stringify(ins.json));
  const f = ins.json.data.fields;
  assert.deepEqual([ins.json.data.status, ins.json.data.source, f.series.length, f.anchor.periodsUsed, f.anchor.skuStableId], ["ok", "edit", 18, 12, null]);
  assert.equal(f.series[8].factor, 1); // natural t=M → P
  assert.ok(f.series[0].factor > 0 && f.series[0].factor < f.series[4].factor && f.series[4].factor < 1, "S-curve crescente");
  assert.ok(validatePremiseCard(toContractCard(ins.json.data)));
  for (const body of [
    { type: "CurvaDemanda", fields: { schema: "a1.curva.v1", series: [] } },
    { type: "CurvaDemanda", status: "ok", fields: { schema: "a1.curva.v1" } },
    { type: "CurvaDemanda", fields: { schema: "a1.curva.v1", rampUpMeses: 9, maturidade: { pct: 100, mes: 3 } } },
    { type: "CurvaDemanda", fields: { schema: "a1.curva.v1", rampUpMeses: 19 } },
  ]) assert.deepEqual([(await call(A, "POST", p, body)).json.error], ["validation_failed"], JSON.stringify(body));
  const x = await call(A, "POST", p, { type: "CurvaDemanda", fields: { schema: "a1.curva.v1", anchor: { nodeStableId: net.BN.stable_id } } });
  assert.deepEqual([x.status, x.json.error], [400, "invalid_reference"]);
});

test("H4: re-ditado mesma âncora/sku/alvo → rejected duplicate_curve (detail.cardId); POST manual duplicado → 409", async () => {
  const first = ((await ok(A, "GET", `/api/scenarios/${scn}`)).cards as any[])
    .find((x) => x.fields?.anchor?.nodeStableId === net.ANC12.stable_id && x.fields?.anchor?.skuStableId === net.S1.stable_id);
  const r = await ditado(A, scn, "de novo", [
    { type: "CurvaDemanda", anchorRef: "ANC12", skuRef: "S1", nodeRef: "FL1", fields: { perfil: "natural" } },
    { type: "Investimento", fields: { capex: 2 } }]);
  assert.equal(r.status, 201);
  assert.deepEqual(reasons(r), [[0, "duplicate_curve"]]);
  assert.equal(r.json.rejected[0].detail.cardId, first.card_id);
  const d = await call(A, "POST", `/api/scenarios/${scn}/premise_cards`, { type: "CurvaDemanda",
    fields: { schema: "a1.curva.v1", anchor: { nodeStableId: net.ANC12.stable_id } }, links: { nodeId: null } });
  assert.deepEqual([d.status, d.json.error], [409, "duplicate_curve"]);
  // outro SKU = outra curva (chave = âncora, sku, alvo)
  const other = await ditado(A, scn, "outro sku", [{ type: "CurvaDemanda", anchorRef: "ANC12", skuRef: "S2", nodeRef: "FL1", fields: {} }]);
  assert.equal(other.status, 201, JSON.stringify(other.json));
  assert.deepEqual([other.json.data[0].fields.gapCode, other.json.data[0].fields.anchor.periodsUsed], ["hist_insufficient", 1]);
});

test("M5: tenant B não lê/edita card nem hist de A; âncora de A no ditado de B = invalid_reference; legado sem schema intacto", async () => {
  const cards = (await ok(A, "GET", `/api/scenarios/${scn}`)).cards as any[];
  const c = cards.find((x) => x.fields?.schema === "a1.curva.v1" && x.status === "ok");
  assert.equal((await call(B, "GET", `/api/scenarios/${scn}`)).status, 404);
  assert.equal((await call(B, "PATCH", `/api/premise_cards/${c.id}`, { fields: { rampUpMeses: 3 }, why: "x" })).status, 404);
  const r = await ditado(B, scnB, "B usa âncora de A", [
    { type: "CurvaDemanda", anchorRef: "ANC12", fields: {} },
    { type: "CurvaDemanda", anchorRef: net.ANC12.stable_id, fields: {} },
    { type: "CurvaDemanda", anchorRef: "BN", fields: {} }]);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(reasons(r), [[0, "invalid_reference"], [1, "invalid_reference"]]);
  assert.equal(r.json.data[0].fields.trace.baseQty, 999, "B só vê o próprio hist");
  // legado (sem schema): aceito/lido/editado como hoje (fieldsSchema escalar; status do cliente)
  const leg = await ok(A, "POST", `/api/scenarios/${scn}/premise_cards`, { type: "CurvaDemanda", status: "ok", fields: { growth: 0.1 } });
  assert.deepEqual([leg.status, leg.fields], ["ok", { growth: 0.1 }]);
  const leg2 = await ok(A, "PATCH", `/api/premise_cards/${leg.id}`, { fields: { growth: 0.2 }, status: "gap", why: "legado" });
  assert.deepEqual([leg2.status, leg2.fields, leg2.version], ["gap", { growth: 0.2 }, 2]);
  assert.equal((await call(A, "PATCH", `/api/premise_cards/${leg.id}`, { fields: { nested: { a: 1 } }, why: "x" })).status, 400);
  assert.equal((await call(A, "POST", `/api/scenarios/${scn}/premise_cards`, { type: "CurvaDemanda", fields: { growth: 0.1 } })).json.error,
    "validation_failed", "legado segue exigindo status");
});

test("H5: A1 off no roster → ditado rejected a1_disabled · POST manual / PATCH v1 → 409; religado volta", async () => {
  await ok(A, "PUT", "/api/tenant-settings", { agent_roster: { A1: { enabled: false } } });
  try {
    const r = await ditado(A, scn, "A1 off", [
      { type: "CurvaDemanda", anchorRef: "ANC0", skuRef: "S2", fields: {} },
      { type: "Investimento", fields: { capex: 3 } }]);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.deepEqual(reasons(r), [[0, "a1_disabled"]]);
    const only = await ditado(A, scn, "A1 off só curva", [{ type: "CurvaDemanda", anchorRef: "NOPE", fields: {} }]);
    assert.deepEqual([only.status, only.json.details.rejected[0].reason], [422, "a1_disabled"], "roster antes da âncora (ordem §3)");
    const m = await call(A, "POST", `/api/scenarios/${scn}/premise_cards`, { type: "CurvaDemanda", fields: { schema: "a1.curva.v1" } });
    assert.deepEqual([m.status, m.json.error], [409, "a1_disabled"]);
    const c = ((await ok(A, "GET", `/api/scenarios/${scn}`)).cards as any[]).find((x) => x.fields?.schema === "a1.curva.v1");
    assert.deepEqual([(await call(A, "PATCH", `/api/premise_cards/${c.id}`, { fields: { perfil: "degrau" }, why: "x" })).status], [409]);
    // legado não depende do roster
    assert.equal((await call(A, "POST", `/api/scenarios/${scn}/premise_cards`, { type: "CurvaDemanda", status: "ok", fields: { growth: 1 } })).status, 201);
  } finally {
    await ok(A, "PUT", "/api/tenant-settings", { agent_roster: { A1: { enabled: true } } });
  }
  const back = await ditado(A, scn, "A1 on", [{ type: "CurvaDemanda", anchorRef: "ANC0", skuRef: "S2", fields: {} }]);
  assert.deepEqual([back.status, back.json.data[0].fields.gapCode], [201, "hist_none"]);
  assert.ok(llmCalls > 0);
});
