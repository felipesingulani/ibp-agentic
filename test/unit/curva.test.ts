// A1 · buildCurva (A1-CURVA-DEMANDA-CONTRACT.md §5) — função pura: 3 perfis, limites 5/6 meses, determinismo, 18 pts, qty ≥ 0.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../src/http/errors.js";
import { buildCurva, curvaFactor, curvaFieldsSchema, mergeCurvaPatch, parseCurvaClient, resolveParams } from "../../src/wizard/curva.js";
import { validateLlmCards } from "../../src/wizard/ditado.js";

const hist = (n: number, to = "2026-10", q = (i: number) => 100) => {
  const [y, m] = to.split("-").map(Number); const t = y * 12 + m - 1;
  return Array.from({ length: n }, (_, i) => { const k = t - i; return { m: `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`, qty: q(i) }; });
};
const P = (p = {}) => resolveParams(p);

test("limites: 0 → hist_none (trace null) · 5 → hist_insufficient (trace, series=[]) · 6 → ok 18 pts", () => {
  assert.deepEqual(buildCurva([], P()), { status: "gap", gapCode: "hist_none", periodsUsed: 0, series: [], trace: null });
  const five = buildCurva(hist(5), P());
  assert.deepEqual([five.status, five.gapCode, five.periodsUsed, five.series], ["gap", "hist_insufficient", 5, []]);
  assert.deepEqual(five.trace, { method: "a1.curva.v1", histFrom: "2026-06", histTo: "2026-10", baseQty: 100, histSource: "sales_history" });
  const six = buildCurva(hist(6), P());
  assert.deepEqual([six.status, six.gapCode, six.periodsUsed, six.series.length], ["ok", null, 6, 18]);
});

test("janela: só os 12 meses mais recentes; meses duplicados (YYYY-MM-DD agregado) somam; buracos permitidos", () => {
  const h = [...hist(20, "2026-10", (i) => (i < 12 ? 10 : 1000)), { m: "2026-10", qty: 5 }];
  const r = buildCurva(h, P());
  assert.deepEqual([r.periodsUsed, r.trace!.histFrom, r.trace!.histTo, r.trace!.baseQty], [12, "2025-11", "2026-10", Math.round(((12 * 10 + 5) / 12) * 100) / 100]);
  const gappy = buildCurva([{ m: "2026-01", qty: 6 }, { m: "2026-03", qty: 6 }, { m: "2026-05", qty: 6 }, { m: "2026-07", qty: 6 }, { m: "2026-09", qty: 6 }, { m: "2026-10", qty: 6 }], P());
  assert.deepEqual([gappy.status, gappy.trace!.histFrom, gappy.series[0].period], ["ok", "2026-01", "2026-11"]);
});

test("horizonte: series[0] = mês seguinte a histTo (vira o ano); 18 pts YYYY-MM consecutivos", () => {
  const r = buildCurva(hist(6, "2026-12"), P());
  assert.equal(r.series[0].period, "2027-01"); assert.equal(r.series[17].period, "2028-06");
  assert.equal(new Set(r.series.map((p) => p.period)).size, 18);
});

test("perfis: linear P·min(t/M,1) · degrau 0 antes do ramp, P depois · natural S-curve monotônica, = P em t ≥ M", () => {
  const lin = buildCurva(hist(12), P({ perfil: "linear", rampUpMeses: 4 })).series;
  assert.deepEqual(lin.slice(0, 5).map((p) => p.factor), [0.25, 0.5, 0.75, 1, 1]);
  assert.deepEqual(lin.slice(0, 2).map((p) => p.qty), [25, 50]);
  const deg = buildCurva(hist(12), P({ perfil: "degrau", rampUpMeses: 3, maturidade: { pct: 120, mes: 5 } })).series;
  assert.deepEqual(deg.slice(0, 4).map((p) => p.factor), [0, 0, 1.2, 1.2]);
  const nat = buildCurva(hist(12), P({ perfil: "natural", rampUpMeses: 9 })).series;
  for (let i = 1; i < 9; i++) assert.ok(nat[i].factor > nat[i - 1].factor, `crescente t=${i + 1}`);
  assert.ok(nat.slice(8).every((p) => p.factor === 1 && p.qty === 100));
  const s = (t: number) => 1 / (1 + Math.exp(-(10 / 9) * (t - 4.5)));
  assert.equal(nat[0].factor, Math.round((s(1) / s(9)) * 10000) / 10000);
  assert.equal(curvaFactor("natural", 9, { rampUpMeses: 9, maturidade: { pct: 80, mes: 9 } }), 0.8);
});

test("determinismo + qty ≥ 0 com 2 casas; hist negativo (devolução) clampa em 0; ordem do hist irrelevante", () => {
  const h = hist(12, "2026-10", (i) => 33.333 + i);
  const a = buildCurva(h, P({ perfil: "natural" })), b = buildCurva([...h].reverse(), P({ perfil: "natural" }));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(a.series.every((p) => p.qty >= 0 && Math.round(p.qty * 100) / 100 === p.qty));
  const neg = buildCurva(hist(6, "2026-10", () => -50), P());
  assert.ok(neg.series.every((p) => p.qty === 0));
});

test("params: defaults natural/9/{100,9}/null; mes < ramp → 400 validation_failed; schema persistido exige 18⇔ok", () => {
  assert.deepEqual(P(), { perfil: "natural", rampUpMeses: 9, maturidade: { pct: 100, mes: 9 }, canibalizacao: null });
  assert.throws(() => P({ rampUpMeses: 9, maturidade: { pct: 100, mes: 3 } }), (e: unknown) => e instanceof HttpError && e.message === "validation_failed");
  const r = buildCurva(hist(6), P());
  const base = { schema: "a1.curva.v1", ...P(), anchor: { nodeStableId: "00000000-0000-4000-8000-000000000001", skuStableId: null, periodsUsed: 6 },
    series: r.series, uom: "un", trace: r.trace, gapCode: null };
  assert.ok(curvaFieldsSchema.safeParse(base).success);
  assert.equal(curvaFieldsSchema.safeParse({ ...base, series: r.series.slice(0, 17) }).success, false);
  assert.equal(curvaFieldsSchema.safeParse({ ...base, gapCode: "hist_insufficient" }).success, false);
  assert.equal(curvaFieldsSchema.safeParse({ ...base, extra: 1 }).success, false);
});

test("cliente: derivados (series/trace/gapCode/uom/anchor.periodsUsed/status) = 400; merge PATCH preserva params e mes segue ramp default", () => {
  for (const f of [{ series: [] }, { trace: null }, { gapCode: null }, { uom: "kg" }, { anchor: { periodsUsed: 1 } }])
    assert.throws(() => parseCurvaClient(f, undefined), (e: unknown) => e instanceof HttpError && e.message === "validation_failed");
  assert.throws(() => parseCurvaClient({}, "ok"), (e: unknown) => e instanceof HttpError && (e.details as any).field === "status");
  const prev = { schema: "a1.curva.v1", perfil: "linear", rampUpMeses: 6, maturidade: { pct: 90, mes: 6 }, canibalizacao: null,
    anchor: { nodeStableId: "00000000-0000-4000-8000-000000000001", skuStableId: null, periodsUsed: 12 }, series: [], uom: null, trace: null, gapCode: null };
  const { draft } = mergeCurvaPatch(prev, parseCurvaClient({ rampUpMeses: 10 }, undefined));
  assert.deepEqual([draft.params.perfil, draft.params.rampUpMeses, draft.params.maturidade, draft.anchorNodeStableId], ["linear", 10, { pct: 90, mes: 10 }, prev.anchor.nodeStableId]);
  assert.deepEqual(mergeCurvaPatch(prev, parseCurvaClient({ anchor: { nodeStableId: "BN" } }, undefined)).draft.invalid,
    { field: "fields.anchor.nodeStableId", ref: "BN" });
});

test("ditado (puro): CurvaDemanda → draft v1; série/qty do LLM descartada; anchorRef/skuRef por code|stable_id; ref inválida marcada", () => {
  const n = { stable_id: "00000000-0000-4000-8000-0000000000a1", code: "ANC", name: "a", node_type: "outro" };
  const k = { stable_id: "00000000-0000-4000-8000-0000000000b1", code: "S1", name: "s" };
  const { cards, rejected, cardIndex } = validateLlmCards({ cards: [
    { type: "CurvaDemanda", anchorRef: "anc", skuRef: "s1", nodeRef: "FL-NOVA", fields: { perfil: "linear", series: [{ qty: 9e9 }], qty: 1, x: 2,
      canibalizacao: { pct: -6, nodeRef: "ANC" } } },
    { type: "CurvaDemanda", anchorRef: "NOPE", fields: {} },
    { type: "CurvaDemanda", fields: { perfil: "exponencial" } },
    { type: "CurvaDemanda", fields: { rampUpMeses: 12, maturidade: { pct: 100, mes: 2 } } },
  ] }, { tenantId: "t", nodes: [n], skus: [k] });
  assert.deepEqual(rejected.map((r) => [r.index, r.reason]), [[2, "validation_failed"], [3, "validation_failed"]]);
  assert.deepEqual(cardIndex, [0, 1]);
  const [a, b] = cards;
  assert.deepEqual([a.type, a.node_id, a.source, a.fields], ["CurvaDemanda", null, "ditado", {}]);
  assert.deepEqual(a.curva, { params: { perfil: "linear", rampUpMeses: 9, maturidade: { pct: 100, mes: 9 }, canibalizacao: { pct: -6, nodeStableId: n.stable_id, nodeRef: "ANC" } },
    anchorNodeStableId: n.stable_id, skuStableId: k.stable_id, nodeRef: "FL-NOVA" });
  assert.deepEqual(b.curva!.invalid, { field: "fields.anchor.nodeStableId", ref: "NOPE" });
});

test("contrato JSON: $defs/curvaDemandaV1 aplicado só a CurvaDemanda v1 (legado/outros tipos livres)", async () => {
  const { validatePremiseCard } = await import("../support/schemas.js");
  const r = buildCurva(hist(6), P());
  const fields = { schema: "a1.curva.v1", ...P(), anchor: { nodeStableId: "00000000-0000-4000-8000-000000000001", skuStableId: null, periodsUsed: 6 },
    series: r.series, uom: "un", trace: r.trace, gapCode: null };
  const card = (f: unknown, type = "CurvaDemanda") => ({ id: "PC-1", type, fields: f, status: "ok", links: { nodeId: null }, version: 1, source: "ditado" });
  assert.ok(validatePremiseCard(card(fields)), JSON.stringify(validatePremiseCard.errors));
  assert.equal(validatePremiseCard(card({ ...fields, series: r.series.slice(1) })), false, "ok exige 18");
  assert.equal(validatePremiseCard(card({ ...fields, gapCode: "hist_none" })), false, "gap exige []");
  assert.equal(validatePremiseCard(card({ ...fields, extra: 1 })), false);
  assert.ok(validatePremiseCard(card({ growth: 0.1 })), "legado sem schema");
  assert.ok(validatePremiseCard(card({ schema: "a1.curva.v1", anything: 1 }, "Investimento")), "outros tipos intactos");
});
