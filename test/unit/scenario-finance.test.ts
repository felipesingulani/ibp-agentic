// T-BIZ-WC-V0 + T-BIZ-MARGIN-STUB — EN-01..05 (AR-01..04). Função pura; sem banco.
import assert from "node:assert/strict";
import { test } from "node:test";
import { effectivePolicyKinds } from "../../src/domain/policy-kinds.js";
import { scenarioImpact } from "../../src/w3/alcada.js";
import {
  assertScenarioFinance, buildScenarioFinance, type FinanceComputeInput, type ScenarioFinance,
} from "../../src/w3/finance.js";
import { fmtKpi } from "../../src/journey/conviction.js";
import type { Kpi } from "../../src/w3/kpi.js";

const kinds = effectivePolicyKinds({});
const defaults = { dso_days: 45, dpo_days: 30, horizon_months: 24, period_days: 30 };

const sku = (o: Partial<FinanceComputeInput["skus"][number]> = {}) => ({
  stable_id: "sku-1", code: "SKU-1", version: 2, unit_cost: 900, unit_price: 1500, ...o,
});

function input(o: Partial<FinanceComputeInput> = {}): FinanceComputeInput {
  return {
    scenarioId: "11111111-1111-4111-8111-111111111111",
    scenarioVersion: 3,
    runId: "22222222-2222-4222-8222-222222222222",
    cadastroVersion: 41,
    stale: false,
    period: "2026-09",
    served: [{ skuId: "sku-1", qty: 1000 }],
    legacyRun: false,
    skus: [sku()],
    premises: [],
    policies: [{ name: "POL-DSI", version: 2, kind: "inventory", body: { dsi_days: 45 } }],
    policyKinds: kinds,
    defaults,
    plan: { objective: 0, lines: null },
    baseline: null,
    ...o,
  };
}

const money = (f: ScenarioFinance, key: "revenue" | "cogs" | "logisticsCost" | "mc" | "deltaMc" | "capexMi" | "deltaWc" | "paybackMonths" | "paybackWithWcMonths") => f[key];

test("EN-01 wc_days_v0: volume×preço/custo, DSI 45, DSO 45, DPO 30, set/2026 (30d) bate a conta à mão", () => {
  // Receita 1000×1500 = 1_500_000 → 1,50 mi
  // CPV    1000×900  =   900_000 → 0,90 mi
  // Estoque (900_000/30)×45 = 1_350_000 → 1,35 mi
  // CR      (1_500_000/30)×45 = 2_250_000 → 2,25 mi
  // CP      (900_000/30)×30 = 900_000 → 0,90 mi
  // WC = 1,35 + 2,25 − 0,90 = 2,70 mi
  // MC = 1,50 − 0,90 − 0 = 0,60 mi
  const f = buildScenarioFinance(input());
  assert.equal(f.financeVersion, "sf.v0");
  assert.deepEqual(f.formulaVersions, { wc: "wc_days_v0", mc: "mc_stub_v0" });
  assert.deepEqual(f.periodDays, { value: 30, source: "period" });
  assert.equal(f.horizonMonths, 24);
  assert.equal(money(f, "revenue").value, 1.5);
  assert.equal(money(f, "cogs").value, 0.9);
  assert.equal(money(f, "logisticsCost").value, 0);
  assert.equal(money(f, "mc").value, 0.6);
  assert.equal(f.wc.inventory.value, 1.35);
  assert.equal(f.wc.receivables.value, 2.25);
  assert.equal(f.wc.payables.value, 0.9);
  assert.equal(f.wc.total.value, 2.7);
  assert.equal(money(f, "deltaMc").nullReason, "no_baseline");
  assert.equal(money(f, "deltaWc").nullReason, "no_baseline");
  assert.equal(money(f, "paybackMonths").nullReason, "no_baseline");
  assert.match(money(f, "deltaMc").source, /projeção linear v0/);
  // fev/2024 tem 29 dias — dias do mês, não o fallback 30
  const feb = buildScenarioFinance(input({
    period: "2024-02",
    served: [{ skuId: "sku-1", qty: 1000 }],
    skus: [sku({ unit_cost: 290, unit_price: 290 })],
    policies: [{ name: "POL-DSI", version: 1, kind: "estoque", body: { dsi_days: 29 } }],
    plan: { objective: 0, lines: null },
  }));
  assert.deepEqual(feb.periodDays, { value: 29, source: "period" });
  assert.equal(feb.wc.inventory.value, 0.29); // (290_000/29)×29 = 290_000 → 0,29 mi
});

test("EN-02 preço ausente em SKU com volume → wc null no_price; nunca 0; sem soma parcial", () => {
  const f = buildScenarioFinance(input({
    skus: [sku({ unit_price: null, unit_cost: 900 }), sku({ stable_id: "sku-2", code: "SKU-2", version: 1, unit_cost: 1, unit_price: 9 })],
    served: [{ skuId: "sku-1", qty: 1000 }, { skuId: "sku-2", qty: 5 }],
  }));
  assert.equal(f.wc.total.value, null);
  assert.equal(f.wc.total.nullReason, "no_price");
  assert.notEqual(f.wc.total.value, 0);
  assert.equal(f.revenue.value, null);
  assert.equal(f.revenue.nullReason, "no_price");
  assert.equal(f.cogs.value, null);
  assert.equal(f.mc.value, null);
  assert.equal(f.deltaMc.nullReason, "no_price");
  assert.ok(f.missing.some((m) => m.stable_id === "sku-1" && m.field === "unit_price" && m.code === "SKU-1" && m.cta === "/cadastro/skus/sku-1"));
  assert.equal(f.missing.filter((m) => m.stable_id === "sku-2").length, 0, "SKU com preço não entra em missing");
});

test("EN-03 ΔMC ≤ 0 → payback null + no_payback_in_horizon; payback > horizonte → payback_beyond_horizon", () => {
  const neg = buildScenarioFinance(input({
    premises: [{ card_id: "PC-1", version: 1, type: "Investimento", fields: { impactMi: 3.4 } }],
    baseline: { mc: 1, wc: 1 },
  }));
  // MC cenário 0,60 − baseline 1,00 = −0,40
  assert.equal(neg.deltaMc.value, -0.4);
  assert.equal(neg.paybackMonths.value, null);
  assert.equal(neg.paybackMonths.nullReason, "no_payback_in_horizon");
  assert.equal(neg.paybackWithWcMonths.nullReason, "no_payback_in_horizon");
  const zero = buildScenarioFinance(input({ baseline: { mc: 0.6, wc: 2.7 } }));
  assert.equal(zero.deltaMc.value, 0);
  assert.equal(zero.paybackMonths.nullReason, "no_payback_in_horizon");

  const beyond = buildScenarioFinance(input({
    premises: [{ card_id: "PC-1", version: 1, type: "Investimento", fields: { impactMi: 3.4 } }],
    baseline: { mc: 0.5, wc: 2.7 },
    // ΔMC = 0,10; payback = 3,4/0,10 = 34 > 24
  }));
  assert.equal(beyond.deltaMc.value, 0.1);
  assert.equal(beyond.paybackMonths.value, null);
  assert.equal(beyond.paybackMonths.nullReason, "payback_beyond_horizon");
});

test("EN-04 capexMi === scenarioImpact().impactMi (fixture 3 + 0,4)", () => {
  const cards = [
    { type: "Investimento", fields: { impactMi: 3 } },
    { type: "Investimento", fields: { impactMi: 0.4 } },
  ];
  const f = buildScenarioFinance(input({
    premises: cards.map((c, i) => ({ card_id: `PC-${i}`, version: 1, type: c.type, fields: c.fields })),
  }));
  const imp = scenarioImpact(cards);
  assert.equal(imp.impactMi, 3.4);
  assert.equal(f.capexMi.value, imp.impactMi);
  assert.equal(f.capexMi.source.includes("Investimento"), true);
});

test("EN-05 precedência: premissa > cadastro > política > default_pack (4 combos)", () => {
  const f = buildScenarioFinance(input({
    skus: [sku({ unit_price: 99, unit_cost: 4 })],
    premises: [{ card_id: "PC-9", version: 4, type: "CurvaDemanda", fields: { skuId: "sku-1", unitPrice: 10, dsi_days: 12 } }],
    policies: [
      { name: "POL-DSI", version: 2, kind: "inventory", body: { dsi_days: 45 } },
      { name: "POL-WC", version: 3, kind: "working_capital", body: { dso_days: 20 } },
    ],
  }));
  const d = Object.fromEntries(f.drivers.map((x) => [x.key, x]));
  assert.deepEqual(d["unit_price:SKU-1"], { key: "unit_price:SKU-1", value: 10, source: "premise", ref: "PC-9 v4" });
  assert.deepEqual(d["unit_cost:SKU-1"], { key: "unit_cost:SKU-1", value: 4, source: "cadastro", ref: "SKU-1 v2" });
  assert.deepEqual(d.dsi, { key: "dsi", value: 12, source: "premise", ref: "PC-9 v4" });
  assert.deepEqual(d.dso, { key: "dso", value: 20, source: "policy", ref: "POL-WC v3" });
  assert.deepEqual(d.dpo, { key: "dpo", value: 30, source: "default_pack", ref: null });
  // sem DSI em lugar nenhum → estoque null + no_policy (não há default de DSI); CR/CP seguem
  const noDsi = buildScenarioFinance(input({ policies: [], premises: [] }));
  assert.equal(noDsi.wc.inventory.nullReason, "no_policy");
  assert.equal(noDsi.wc.inventory.value, null);
  assert.equal(noDsi.wc.receivables.value, 2.25);
  assert.equal(noDsi.wc.total.nullReason, "no_policy");
  assert.equal(noDsi.drivers.some((x) => x.key === "dsi"), false);
});

test("baseline incompleto propaga o nullReason real; baseline ausente fica no_baseline", () => {
  const absent = buildScenarioFinance(input());
  assert.equal(absent.mc.value, 0.6);
  assert.equal(absent.wc.total.value, 2.7);
  assert.equal(absent.deltaMc.nullReason, "no_baseline");
  assert.equal(absent.deltaWc.nullReason, "no_baseline");
  assert.equal(absent.paybackMonths.nullReason, "no_baseline");
  assert.equal(absent.paybackWithWcMonths.nullReason, "no_baseline");
  assertScenarioFinance(absent);

  const price = buildScenarioFinance(input({
    baseline: { mc: null, wc: null, mcNullReason: "no_price", wcNullReason: "no_price" },
  }));
  assert.equal(price.deltaMc.value, null);
  assert.equal(price.deltaMc.nullReason, "no_price");
  assert.equal(price.deltaWc.nullReason, "no_price");
  assert.equal(price.paybackMonths.nullReason, "no_price");
  assert.equal(price.paybackWithWcMonths.nullReason, "no_price");
  assert.notEqual(price.deltaMc.nullReason, "no_baseline");
  assertScenarioFinance(price);

  const cost = buildScenarioFinance(input({
    baseline: { mc: null, wc: 1, mcNullReason: "no_cost" },
  }));
  assert.equal(cost.deltaMc.nullReason, "no_cost");
  assert.equal(cost.deltaWc.value, 1.7);
  assert.equal(cost.deltaWc.nullReason, undefined);
  assertScenarioFinance(cost);

  const policy = buildScenarioFinance(input({
    premises: [{ card_id: "PC-1", version: 1, type: "Investimento", fields: { impactMi: 1.2 } }],
    baseline: { mc: 0.5, wc: null, wcNullReason: "no_policy" },
  }));
  assert.equal(policy.deltaMc.value, 0.1);
  assert.equal(policy.deltaWc.value, null);
  assert.equal(policy.deltaWc.nullReason, "no_policy");
  assert.equal(policy.paybackMonths.value, 12);
  assert.equal(policy.paybackWithWcMonths.nullReason, "no_policy");
  assert.notEqual(policy.deltaWc.nullReason, "no_baseline");
  assertScenarioFinance(policy);

  // o buraco do próprio cenário continua na frente do nullReason do baseline
  const own = buildScenarioFinance(input({
    skus: [sku({ unit_price: null })],
    baseline: { mc: 0.2, wc: 1 },
  }));
  assert.equal(own.deltaMc.nullReason, "no_price");
  assert.equal(own.deltaWc.nullReason, "no_price");
});

test("período inválido usa os dias do pack e source default_pack; YYYY-MM usa o mês e source period", () => {
  const bad = buildScenarioFinance(input({
    period: "2026-13",
    defaults: { ...defaults, period_days: 28 },
  }));
  assert.deepEqual(bad.periodDays, { value: 28, source: "default_pack" });
  // (900_000/28)×45 = 1_446_428,57 → 1,45 mi: o fallback entra na conta, não é rótulo solto
  assert.equal(bad.wc.inventory.value, 1.45);
  assertScenarioFinance(bad);

  const blank = buildScenarioFinance(input({ period: null }));
  assert.deepEqual(blank.periodDays, { value: 30, source: "default_pack" });
  assertScenarioFinance(blank);

  const dated = buildScenarioFinance(input({ period: "2026-09-01" }));
  assert.deepEqual(dated.periodDays, { value: 30, source: "default_pack" });

  const sep = buildScenarioFinance(input({ period: "2026-09" }));
  assert.deepEqual(sep.periodDays, { value: 30, source: "period" });
  assert.equal(sep.wc.inventory.value, 1.35);
  assertScenarioFinance(sep);
});

test("rótulos sf.v0 saem do mapa único de conviction.ts", () => {
  const k = (nullReason: Kpi["nullReason"]): Kpi =>
    ({ key: "wc", label: "Working capital", value: null, unit: "BRL mi", nullReason, source: "sf.v0" });
  assert.equal(fmtKpi(k("no_price")), "— (falta preço unitário)");
  assert.equal(fmtKpi(k("no_cost")), "— (falta custo unitário)");
  assert.equal(fmtKpi(k("no_baseline")), "— (sem plano vigente para comparar)");
  assert.equal(fmtKpi(k("no_payback_in_horizon")), "— (não se paga no horizonte)");
  assert.equal(fmtKpi(k("payback_beyond_horizon")), "— (acima do horizonte)");
  assert.equal(fmtKpi(k("cost_breakdown_unavailable")), "— (quebra de custo indisponível)");
  assert.equal(fmtKpi(k("legacy_run")), "— (run legado sem volume por SKU)");
  assert.equal(fmtKpi(k("no_policy")), "— (sem política de DSI)");
});
