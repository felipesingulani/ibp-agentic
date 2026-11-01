// W1c unit: modelo piloto + CBC real (processo filho, sem mock) + explicações no schema do contrato.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel, checkPilotLimits, paramsFrom, type Snapshot } from "../../src/a4/model.js";
import { solve } from "../../src/a4/solve.js";
import { explain, toReasonKind } from "../../src/a4/explain.js";
import { validateReason, validateSummary } from "../support/schemas.js";
import { effectivePolicyKinds } from "../../src/domain/policy-kinds.js";
import { getPack } from "../../src/cadastro/packs.js";

const fixture = (over: Partial<Snapshot> = {}): Snapshot => ({
  scenario: { id: "sc", version: 3, code: "SC" },
  period: "2026-10",
  nodes: [{ id: "cd1", code: "CD1" }, { id: "cd2", code: "CD2" }, { id: "l1", code: "L1" }, { id: "l2", code: "L2" }],
  capacity: { cd1: 100, cd2: 50 },
  routes: [
    { id: "r1", code: "R1", origin: "cd1", dest: "l1", cost: 2, leadTimeDays: 1 },
    { id: "r2", code: "R2", origin: "cd2", dest: "l1", cost: 5, leadTimeDays: 4 },
    { id: "r3", code: "R3", origin: "cd1", dest: "l2", cost: 3, leadTimeDays: 1 },
    { id: "r4", code: "R4", origin: "cd2", dest: "l2", cost: 1, leadTimeDays: 1 },
  ],
  skus: [{ id: "s1", code: "S1" }, { id: "s2", code: "S2" }],
  demand: [{ node: "l1", sku: "s1", qty: 60 }, { node: "l1", sku: "s2", qty: 30 }, { node: "l2", sku: "s1", qty: 50 }, { node: "l2", sku: "s2", qty: 20 }],
  policies: [{ id: "p1", kind: "Serviço", body: { min_fill_rate: 0.98, max_lead_time_days: 3 } }],
  contracts: [],
  gapCards: [],
  ...over,
});

async function run(s: Snapshot) {
  const p = paramsFrom(s);
  const r = await solve(buildModel(s, p, 3000));
  assert.equal(r.status, "optimal");
  return explain(s, p, r);
}

test("capacity shortage: real CBC run → unmet = demand − capacity, capacidade block first, schema-valid", async () => {
  const out = await run(fixture());
  assert.equal(out.plan.totals.demand, 160);
  assert.ok(Math.abs(out.plan.totals.unmet - 10) < 1e-6, String(out.plan.totals.unmet));
  assert.equal(out.reasons[0].kind, "capacidade");
  assert.equal(out.reasons[0].severity, "block");
  assert.ok(out.reasons.length <= 3);
  for (const r of out.reasons) assert.ok(validateReason(r), JSON.stringify(validateReason.errors));
  const summary = { runId: "x", scenarioId: "sc", scenarioVersion: 3, reasons: out.reasons, countsByKind: out.countsByKind };
  assert.ok(validateSummary(summary), JSON.stringify(validateSummary.errors));
  assert.deepEqual(Object.keys(out.countsByKind).sort(), ["capacidade", "contrato", "custo", "janela", "outro"]);
  assert.ok(out.countsByKind.capacidade >= 1 && out.countsByKind.custo >= 1);
  // utilização: ambas as origens no limite
  assert.deepEqual(out.plan.utilization.map((u) => u.pct), [100, 100]);
});

test("enough capacity: all served, late route avoided when cheaper on-time route has room", async () => {
  const out = await run(fixture({ capacity: { cd1: 500, cd2: 500 } }));
  assert.equal(out.plan.totals.unmet, 0);
  assert.ok(!out.plan.flows.some((f) => f.routeCode === "R2"), "R2 acima do lead time não deve ser usada");
  assert.equal(out.countsByKind.janela, 0);
  assert.ok(out.reasons.every((r) => r.severity !== "block"));
});

test("late route forced → janela; contract min → contrato; gap card legacy tancagem → capacidade", async () => {
  const s = fixture({
    capacity: { cd2: 500 }, // só CD2 tem capacidade → L1 só por R2 (acima do lead time)
    contracts: [{ id: "c1", code: "C1", skuIds: ["s1"], minVolume: 500, maxVolume: null }],
    gapCards: [{ id: "g", cardId: "PC-1", nodeId: "l1", fields: { kind: "tancagem", need: "falta tanque" } }],
  });
  const out = await run(s);
  assert.ok(out.countsByKind.janela >= 1);
  assert.ok(out.countsByKind.contrato >= 1);
  assert.ok(out.countsByKind.capacidade >= 1);
  const all = JSON.stringify(out);
  assert.ok(!/"kind":"tancagem"/.test(all));
  for (const r of out.reasons) assert.ok(["janela", "capacidade", "contrato", "custo", "outro"].includes(r.kind));
});

test("kind mapping is closed on the contract enum", () => {
  assert.equal(toReasonKind("tancagem"), "capacidade");
  assert.equal(toReasonKind("Capacidade"), "capacidade");
  assert.equal(toReasonKind("rota"), "outro");
  assert.equal(toReasonKind("politica"), "outro");
  assert.equal(toReasonKind(undefined), "outro");
});

test("pilot limits", () => {
  const many = Array.from({ length: 51 }, (_, i) => ({ id: `n${i}`, code: `N${i}` }));
  assert.match(checkPilotLimits(fixture({ nodes: many })) ?? "", /pilot_limit/);
  assert.equal(checkPilotLimits(fixture()), null);
});

// F-1 (W5 residual): paramsFrom lê o vocabulário do tenant (tenant_settings.policy_kinds via Snapshot.policyKinds), não POLICY_KINDS.
test("F-1 paramsFrom: alias custom em policy_kinds.service (pack retail 'fill_rate') contribui min_fill_rate", () => {
  const retail = effectivePolicyKinds(getPack("retail")!.policy_kinds);
  const s = fixture({ policyKinds: retail, policies: [{ id: "p1", kind: "Fill Rate", body: { min_fill_rate: 0.95, max_lead_time_days: 2 } }] });
  const p = paramsFrom(s);
  assert.equal(p.minFillRate, 0.95);
  assert.equal(p.maxLeadTimeDays, 2);
  // mesmo kind no vocabulário legado ({}) é descartado — prova que o filtro segue o tenant
  assert.equal(paramsFrom(fixture({ policyKinds: effectivePolicyKinds({}), policies: s.policies })).minFillRate, null);
});

test("F-1 paramsFrom: kind fora do vocabulário do tenant é ignorado (mesmo sendo alias legado); alçada não entra", () => {
  const k = effectivePolicyKinds({ working_capital: ["giro"], inventory: ["lastro"], service: ["nivel_servico"], alcada: ["alcada"] });
  const s = fixture({ policyKinds: k, policies: [
    { id: "p1", kind: "service", body: { min_fill_rate: 0.99 } },          // legado, mas fora do objeto do tenant
    { id: "p2", kind: "alcada", body: { min_fill_rate: 0.97 } },           // grupo alçada não alimenta o modelo
    { id: "p3", kind: "Lastro", body: { weights: { unmet: 7 } } },         // inventory custom → pesos
    { id: "p4", kind: "Nível-Serviço", body: { min_fill_rate: 0.9 } },     // service custom (normalizado)
  ] });
  const p = paramsFrom(s);
  assert.equal(p.minFillRate, 0.9);
  assert.equal(p.weights.unmet, 7);
});

test("F-1 paramsFrom: policy_kinds {} ou ausente ≡ legado (Serviço/estoque/capital de giro)", () => {
  const pols = [{ id: "p1", kind: "Serviço", body: { min_fill_rate: 0.98 } }, { id: "p2", kind: "capital de giro", body: { weights: { window: 9 } } }];
  for (const policyKinds of [undefined, effectivePolicyKinds({}), effectivePolicyKinds(null)]) {
    const p = paramsFrom(fixture({ policyKinds, policies: pols }));
    assert.deepEqual([p.minFillRate, p.weights.window], [0.98, 9]);
  }
});
