/**
 * T-BIZ-WC-V0 + T-BIZ-MARGIN-STUB (AR-01..04, AR-08). Fonte única de WC / MC / payback.
 * On-read: Pulse, Visões, decisão e A7 só consomem. Sem migration, sem env, sem escrita.
 *
 * wc_days_v0: Receita = Σ volume×preço · CPV = Σ volume×custo · Estoque = CPV/dias×DSI ·
 *   CR = Receita/dias×DSO · CP = CPV/dias×DPO · WC = Estoque + CR − CP.
 *   Volume = served do run (local + flows) por SKU. Moeda em mi, 2 casas.
 * mc_stub_v0: MC = Receita − CPV − CustoLogístico · payback = capex/ΔMC mensal.
 *   1 período → horizonte linear ("projeção linear v0"). capexMi = scenarioImpact().
 * Preço/custo faltante em SKU com volume > 0 → agregados null (nunca soma parcial, nunca 0 silencioso).
 */
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Client } from "../db/pool.js";
import { effectivePolicyKinds, inKindGroup, type EffectivePolicyKinds } from "../domain/policy-kinds.js";
import { genericPack, getPack } from "../cadastro/packs.js";
import { runIsStale, type RunFacts } from "../a7/decision.js";
import { lastPremiseChangeAt } from "../a7/premise-change.js";
import { scenarioImpact } from "./alcada.js";
import { resolvePlanRef } from "./plan-ref.js";

export const FINANCE_VERSION = "sf.v0" as const;
export const FORMULA_VERSIONS = { wc: "wc_days_v0", mc: "mc_stub_v0" } as const;
export const FINANCE_NULL_REASONS = [
  "no_plan", "no_price", "no_cost", "no_baseline", "no_payback_in_horizon",
  "payback_beyond_horizon", "cost_breakdown_unavailable", "legacy_run", "no_policy",
] as const;
export type FinanceNullReason = (typeof FINANCE_NULL_REASONS)[number];
export type DriverSource = "premise" | "cadastro" | "policy" | "default_pack";

export interface Money { value: number | null; nullReason?: FinanceNullReason; source: string }
export interface FinanceDriver { key: string; value: number; source: DriverSource; ref: string | null }
export interface FinanceMissing {
  entity: "sku"; stable_id: string; code: string; field: "unit_price" | "unit_cost"; cta: string;
}
export interface ScenarioFinance {
  financeVersion: typeof FINANCE_VERSION;
  formulaVersions: typeof FORMULA_VERSIONS;
  scenarioId: string;
  scenarioVersion: number;
  runId: string | null;
  cadastroVersion: number;
  stale: boolean;
  period: string | null;
  periodDays: number;
  horizonMonths: number;
  revenue: Money; cogs: Money; logisticsCost: Money; mc: Money;
  deltaMc: Money; capexMi: Money;
  wc: { inventory: Money; receivables: Money; payables: Money; total: Money };
  deltaWc: Money;
  paybackMonths: Money; paybackWithWcMonths: Money;
  drivers: FinanceDriver[];
  missing: FinanceMissing[];
}

export interface PackFinanceDefaults {
  dso_days: number; dpo_days: number; horizon_months: number; period_days: number;
}
export interface SkuFacts {
  stable_id: string; code: string; version: number; unit_cost: number | null; unit_price: number | null;
}
export interface PremiseFact { card_id: string; version: number; type: string; fields: Record<string, unknown> }
export interface PolicyFact { name: string; version: number; kind: string; body: Record<string, unknown> }
export interface FinanceComputeInput {
  scenarioId: string;
  scenarioVersion: number;
  runId: string | null;
  cadastroVersion: number;
  stale: boolean;
  period: string | null;
  /** null = sem run (no_plan). Array (mesmo vazio) = served explícito do plano. */
  served: { skuId: string; qty: number }[] | null;
  legacyRun: boolean;
  skus: SkuFacts[];
  premises: PremiseFact[];
  policies: PolicyFact[];
  policyKinds: EffectivePolicyKinds;
  defaults: PackFinanceDefaults;
  plan: { objective: number | null; lines?: { cost: unknown }[] | null } | null;
  /** null = sem plano vigente. Números null = baseline existe mas o lado dele não fecha. */
  baseline: { mc: number | null; wc: number | null } | null;
}

const MI = 1_000_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const toMi = (currency: number) => round2(currency / MI);
const SRC_LIN = "projeção linear v0";
const SRC_WC = "wc_days_v0";
const SRC_MC = `mc_stub_v0 · ${SRC_LIN}`;
const SRC_CAPEX = "premise_cards[type=Investimento].fields.impactMi";

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.trim()))) return Number(v.trim());
  return null;
};
const asObj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

function V(value: number | null, source: string, nullReason?: FinanceNullReason): Money {
  if (value === null) {
    const m: Money = { value: null, source };
    if (nullReason) m.nullReason = nullReason;
    return m;
  }
  return { value: round2(value), source };
}

/** Dias do mês quando o período é YYYY-MM; senão o fallback do pack (source default_pack). */
export function daysInPeriod(period: string | null, fallback: number): { days: number; fromMonth: boolean } {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period ?? "");
  if (!m) return { days: fallback, fromMonth: false };
  return { days: new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate(), fromMonth: true };
}

export function financeDefaultsOf(packId: string | null | undefined): PackFinanceDefaults {
  const p = (packId && getPack(packId)) || genericPack();
  return p.finance;
}

function cited(fields: Record<string, unknown>, skus: SkuFacts[]): string[] {
  const ids = new Set<string>();
  for (const key of ["skuId", "sku_id", "sku", "skuCode", "sku_code"]) {
    const v = fields[key];
    if (typeof v !== "string" || !v) continue;
    const hit = skus.find((s) => s.stable_id === v || s.code === v);
    if (hit) ids.add(hit.stable_id);
  }
  return [...ids];
}

function bestPremise(premises: PremiseFact[], keys: string[], skuId?: string, skus?: SkuFacts[]): { value: number; ref: string } | null {
  const hits: { p: PremiseFact; n: number }[] = [];
  for (const p of premises) {
    if (skuId && skus && !cited(p.fields, skus).includes(skuId)) continue;
    for (const k of keys) {
      const n = num(p.fields[k]);
      if (n !== null) { hits.push({ p, n }); break; }
    }
  }
  hits.sort((a, b) => b.p.version - a.p.version || a.p.card_id.localeCompare(b.p.card_id));
  const top = hits[0];
  return top ? { value: top.n, ref: `${top.p.card_id} v${top.p.version}` } : null;
}

function bestPolicy(policies: PolicyFact[], kinds: EffectivePolicyKinds, group: "inventory" | "working_capital", key: string) {
  const hits = policies
    .filter((p) => inKindGroup(kinds, p.kind, group))
    .map((p) => ({ p, n: num((p.body ?? {})[key]) }))
    .filter((x): x is { p: PolicyFact; n: number } => x.n !== null);
  hits.sort((a, b) => b.p.version - a.p.version || a.p.name.localeCompare(b.p.name));
  const top = hits[0];
  return top ? { value: top.n, ref: `${top.p.name} v${top.p.version}` } : null;
}

interface Resolved { value: number | null; source: DriverSource; ref: string | null }

function resolveCycle(
  input: FinanceComputeInput, premiseKeys: string[], group: "inventory" | "working_capital", bodyKey: string, fallback: number | null,
): Resolved {
  const prem = bestPremise(input.premises, premiseKeys);
  if (prem) return { value: prem.value, source: "premise", ref: prem.ref };
  const pol = bestPolicy(input.policies, input.policyKinds, group, bodyKey);
  if (pol) return { value: pol.value, source: "policy", ref: pol.ref };
  if (fallback !== null) return { value: fallback, source: "default_pack", ref: null };
  return { value: null, source: "default_pack", ref: null };
}

function skuPriceCost(input: FinanceComputeInput, sku: SkuFacts): { price: Resolved; cost: Resolved } {
  const priceP = bestPremise(input.premises, ["unitPrice", "unit_price"], sku.stable_id, input.skus);
  const costP = bestPremise(input.premises, ["unitCost", "unit_cost"], sku.stable_id, input.skus);
  const ref = `${sku.code} v${sku.version}`;
  return {
    price: priceP ? { value: priceP.value, source: "premise", ref: priceP.ref }
      : sku.unit_price !== null ? { value: sku.unit_price, source: "cadastro", ref } : { value: null, source: "cadastro", ref: null },
    cost: costP ? { value: costP.value, source: "premise", ref: costP.ref }
      : sku.unit_cost !== null ? { value: sku.unit_cost, source: "cadastro", ref } : { value: null, source: "cadastro", ref: null },
  };
}

function logisticsOf(input: FinanceComputeInput): { currency: number | null; reason?: FinanceNullReason; source: string } {
  const lines = input.plan?.lines;
  if (Array.isArray(lines) && lines.length) {
    const known = lines.map((l) => num(l.cost)).filter((x): x is number => x !== null);
    if (!known.length) return { currency: null, reason: "cost_breakdown_unavailable", source: "a4_run.plan.lines" };
    const partial = lines.some((l) => num(l.cost) === null);
    return {
      currency: known.reduce((a, b) => a + b, 0),
      source: partial ? `a4_run.plan.lines[].cost · cost_breakdown_unavailable` : "a4_run.plan.lines[].cost",
    };
  }
  const obj = num(input.plan?.objective);
  if (obj === null) return { currency: null, reason: "cost_breakdown_unavailable", source: "a4_run.plan.objective" };
  return { currency: obj, source: `a4_run.plan.objective · cost_breakdown_unavailable` };
}

function blank(reason: FinanceNullReason, source: string): Money { return V(null, source, reason); }

function shell(input: FinanceComputeInput, days: number, horizon: number, capex: Money, partial: {
  revenue: Money; cogs: Money; logisticsCost: Money; mc: Money;
  wc: ScenarioFinance["wc"]; drivers: FinanceDriver[]; missing: FinanceMissing[];
}): ScenarioFinance {
  const dMc = deltaMoney(partial.mc, input.baseline ? input.baseline.mc : undefined, SRC_MC);
  const dWc = deltaMoney(partial.wc.total, input.baseline ? input.baseline.wc : undefined, `${SRC_WC} · ${SRC_LIN}`);
  return {
    financeVersion: FINANCE_VERSION, formulaVersions: FORMULA_VERSIONS,
    scenarioId: input.scenarioId, scenarioVersion: input.scenarioVersion, runId: input.runId,
    cadastroVersion: input.cadastroVersion, stale: input.stale, period: input.period,
    periodDays: days, horizonMonths: horizon,
    revenue: partial.revenue, cogs: partial.cogs, logisticsCost: partial.logisticsCost, mc: partial.mc,
    deltaMc: dMc, capexMi: capex, wc: partial.wc, deltaWc: dWc,
    paybackMonths: paybackOf(capex.value, dMc, 0, horizon, SRC_MC),
    paybackWithWcMonths: paybackOf(capex.value, dMc, dWc.value, horizon, SRC_MC, dWc.nullReason),
    drivers: partial.drivers, missing: partial.missing,
  };
}

/** baselineNum undefined = não há plano vigente; null = o baseline não fechou o número. */
function deltaMoney(side: Money, baselineNum: number | null | undefined, source: string): Money {
  if (side.value === null) return V(null, source, side.nullReason);
  if (baselineNum === undefined || baselineNum === null) return V(null, source, "no_baseline");
  return V(round2(side.value - baselineNum), source);
}

function paybackOf(capex: number | null, deltaMc: Money, extra: number | null, horizon: number, source: string, extraReason?: FinanceNullReason): Money {
  if (deltaMc.value === null) return V(null, source, deltaMc.nullReason);
  if (deltaMc.value <= 0) return V(null, source, "no_payback_in_horizon");
  if (extra === null) return V(null, source, extraReason);
  if (capex === null) return V(null, source);
  const months = round2((capex + extra) / deltaMc.value);
  if (months > horizon) return V(null, source, "payback_beyond_horizon");
  return V(months, source);
}

export function buildScenarioFinance(input: FinanceComputeInput): ScenarioFinance {
  const { days } = daysInPeriod(input.period, input.defaults.period_days);
  const horizonHit = bestPremise(input.premises, ["horizonMonths", "horizon_months"]);
  const horizon = horizonHit && horizonHit.value > 0 ? horizonHit.value : input.defaults.horizon_months;
  const capexImp = scenarioImpact(input.premises.map((p) => ({ type: p.type, fields: p.fields })));
  const capex = V(capexImp.impactMi, SRC_CAPEX);

  const blocked = (reason: FinanceNullReason): ScenarioFinance => shell(input, days, horizon, capex, {
    revenue: blank(reason, SRC_WC), cogs: blank(reason, SRC_WC),
    logisticsCost: blank(reason, "a4_run.plan"), mc: blank(reason, SRC_MC),
    wc: { inventory: blank(reason, SRC_WC), receivables: blank(reason, SRC_WC), payables: blank(reason, SRC_WC), total: blank(reason, SRC_WC) },
    drivers: cycleDrivers(input), missing: [],
  });

  if (!input.runId) return blocked("no_plan");
  if (input.legacyRun || input.served === null) return blocked(input.legacyRun ? "legacy_run" : "no_plan");

  const qty = new Map<string, number>();
  for (const row of input.served) {
    const q = num(row.qty) ?? 0;
    if (q > 0 && row.skuId) qty.set(row.skuId, (qty.get(row.skuId) ?? 0) + q);
  }

  const drivers = cycleDrivers(input);
  const missing: FinanceMissing[] = [];
  let revenueCur = 0, cogsCur = 0;
  let priceGap = false, costGap = false;
  const skuById = new Map(input.skus.map((s) => [s.stable_id, s]));
  const used = [...qty.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [skuId, q] of used) {
    const sku = skuById.get(skuId);
    if (!sku) {
      missing.push({ entity: "sku", stable_id: skuId, code: skuId, field: "unit_price", cta: `/cadastro/skus/${skuId}` });
      missing.push({ entity: "sku", stable_id: skuId, code: skuId, field: "unit_cost", cta: `/cadastro/skus/${skuId}` });
      priceGap = costGap = true;
      continue;
    }
    const pc = skuPriceCost(input, sku);
    if (pc.price.value === null) {
      priceGap = true;
      missing.push({ entity: "sku", stable_id: sku.stable_id, code: sku.code, field: "unit_price", cta: `/cadastro/skus/${sku.stable_id}` });
    } else {
      revenueCur += q * pc.price.value;
      drivers.push({ key: `unit_price:${sku.code}`, value: pc.price.value, source: pc.price.source, ref: pc.price.ref });
    }
    if (pc.cost.value === null) {
      costGap = true;
      missing.push({ entity: "sku", stable_id: sku.stable_id, code: sku.code, field: "unit_cost", cta: `/cadastro/skus/${sku.stable_id}` });
    } else {
      cogsCur += q * pc.cost.value;
      drivers.push({ key: `unit_cost:${sku.code}`, value: pc.cost.value, source: pc.cost.source, ref: pc.cost.ref });
    }
  }
  drivers.sort((a, b) => driverRank(a.key) - driverRank(b.key) || a.key.localeCompare(b.key));
  missing.sort((a, b) => a.code.localeCompare(b.code) || a.field.localeCompare(b.field));

  const gap: FinanceNullReason | null = priceGap ? "no_price" : costGap ? "no_cost" : null;
  const log = logisticsOf(input);
  const logisticsCost = log.currency === null ? blank(log.reason ?? "cost_breakdown_unavailable", log.source) : V(toMi(log.currency), log.source);

  if (gap) {
    return shell(input, days, horizon, capex, {
      revenue: blank(gap, `${SRC_WC} · served×preço`), cogs: blank(gap, `${SRC_WC} · served×custo`),
      logisticsCost, mc: blank(gap, SRC_MC),
      wc: { inventory: blank(gap, SRC_WC), receivables: blank(gap, SRC_WC), payables: blank(gap, SRC_WC), total: blank(gap, SRC_WC) },
      drivers, missing,
    });
  }

  const dsi = resolveCycle(input, ["dsi_days", "dsiDays"], "inventory", "dsi_days", null);
  const dso = resolveCycle(input, ["dso_days", "dsoDays"], "working_capital", "dso_days", input.defaults.dso_days);
  const dpo = resolveCycle(input, ["dpo_days", "dpoDays"], "working_capital", "dpo_days", input.defaults.dpo_days);
  const revenue = V(toMi(revenueCur), `${SRC_WC} · served×preço`);
  const cogs = V(toMi(cogsCur), `${SRC_WC} · served×custo`);
  const inventory = dsi.value === null ? blank("no_policy", SRC_WC) : V(toMi((cogsCur / days) * dsi.value), `${SRC_WC} · dsi ${dsi.source}`);
  const receivables = V(toMi((revenueCur / days) * (dso.value as number)), `${SRC_WC} · dso ${dso.source}`);
  const payables = V(toMi((cogsCur / days) * (dpo.value as number)), `${SRC_WC} · dpo ${dpo.source}`);
  const total = inventory.value === null || receivables.value === null || payables.value === null
    ? blank(inventory.nullReason ?? "no_policy", SRC_WC)
    : V(round2(inventory.value + receivables.value - payables.value), SRC_WC);
  const mc = logisticsCost.value === null
    ? blank(logisticsCost.nullReason ?? "cost_breakdown_unavailable", SRC_MC)
    : V(round2((revenue.value as number) - (cogs.value as number) - logisticsCost.value), SRC_MC);

  return shell(input, days, horizon, capex, {
    revenue, cogs, logisticsCost, mc, wc: { inventory, receivables, payables, total }, drivers, missing,
  });
}

function cycleDrivers(input: FinanceComputeInput): FinanceDriver[] {
  const out: FinanceDriver[] = [];
  const dsi = resolveCycle(input, ["dsi_days", "dsiDays"], "inventory", "dsi_days", null);
  const dso = resolveCycle(input, ["dso_days", "dsoDays"], "working_capital", "dso_days", input.defaults.dso_days);
  const dpo = resolveCycle(input, ["dpo_days", "dpoDays"], "working_capital", "dpo_days", input.defaults.dpo_days);
  if (dsi.value !== null) out.push({ key: "dsi", value: dsi.value, source: dsi.source, ref: dsi.ref });
  if (dso.value !== null) out.push({ key: "dso", value: dso.value, source: dso.source, ref: dso.ref });
  if (dpo.value !== null) out.push({ key: "dpo", value: dpo.value, source: dpo.source, ref: dpo.ref });
  return out;
}

function driverRank(key: string): number {
  if (key === "dsi") return 0;
  if (key === "dso") return 1;
  if (key === "dpo") return 2;
  if (key.startsWith("unit_price:")) return 3;
  return 4;
}

const schema = JSON.parse(readFileSync(new URL("../../contracts/scenario-finance.schema.json", import.meta.url), "utf8"));
const validateFinance = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
export function assertScenarioFinance(out: unknown): void {
  if (!validateFinance(out)) throw new Error(`ScenarioFinance fora do contrato: ${validateFinance.errors?.map((e) => `${e.instancePath} ${e.message}`).join("; ")}`);
}

export interface PackAudit {
  financeVersion: typeof FINANCE_VERSION;
  formulaVersions: typeof FORMULA_VERSIONS;
  runId: string | null;
  scenarioVersion: number;
  cadastroVersion: number;
  capexMi: Money; deltaWc: Money; deltaMc: Money; paybackMonths: Money; paybackWithWcMonths: Money;
  gates: { state: "ok" | "warn" | "block"; items: unknown[] };
}

/** Snapshot AR-08 gravado em audit_log.payload.pack e no pacote A7. */
export function packAuditOf(fin: ScenarioFinance, gates: { state: "ok" | "warn" | "block"; items: unknown[] }): PackAudit {
  return {
    financeVersion: fin.financeVersion, formulaVersions: fin.formulaVersions, runId: fin.runId,
    scenarioVersion: fin.scenarioVersion, cadastroVersion: fin.cadastroVersion,
    capexMi: fin.capexMi, deltaWc: fin.deltaWc, deltaMc: fin.deltaMc,
    paybackMonths: fin.paybackMonths, paybackWithWcMonths: fin.paybackWithWcMonths, gates,
  };
}

interface CoreParts { input: FinanceComputeInput; mc: number | null; wc: number | null }

function planParts(plan: unknown): { served: { skuId: string; qty: number }[] | null; legacy: boolean; objective: number | null; lines: { cost: unknown }[] | null; period: string | null } {
  const p = asObj(plan);
  if (!p) return { served: null, legacy: true, objective: null, lines: null, period: null };
  const hasLocal = Array.isArray(p.local);
  const hasFlows = Array.isArray(p.flows);
  const served: { skuId: string; qty: number }[] = [];
  if (hasLocal) for (const l of p.local as Record<string, unknown>[]) {
    const skuId = typeof l.skuId === "string" ? l.skuId : "";
    served.push({ skuId, qty: num(l.qty) ?? 0 });
  }
  if (hasFlows) for (const f of p.flows as Record<string, unknown>[]) {
    const skuId = typeof f.skuId === "string" ? f.skuId : "";
    served.push({ skuId, qty: num(f.qty) ?? 0 });
  }
  return {
    served: hasLocal || hasFlows ? served : null,
    legacy: !hasLocal && !hasFlows,
    objective: num(p.objective),
    lines: Array.isArray(p.lines) ? p.lines as { cost: unknown }[] : null,
    period: typeof p.period === "string" ? p.period : null,
  };
}

async function cadastroVersionOf(c: Client): Promise<number> {
  const r = await c.query(`SELECT (
      COALESCE((SELECT SUM(version) FROM nodes WHERE is_current), 0)
    + COALESCE((SELECT SUM(version) FROM skus WHERE is_current), 0)
    + COALESCE((SELECT SUM(version) FROM policies WHERE is_current), 0)
    + COALESCE((SELECT SUM(version) FROM routes WHERE is_current), 0)
    + COALESCE((SELECT SUM(version) FROM node_capacity WHERE is_current), 0)
    + COALESCE((SELECT SUM(version) FROM supplier_contracts WHERE is_current), 0)
    + COALESCE((SELECT SUM(version) FROM finance_drivers WHERE is_current), 0)
  )::int AS v`);
  return Number(r.rows[0].v ?? 0);
}

async function masterData(c: Client, scenarioId: string) {
  const st = (await c.query("SELECT industry_pack, policy_kinds FROM tenant_settings")).rows[0] ?? {};
  const skus = (await c.query("SELECT stable_id, code, version, unit_cost, attrs FROM skus WHERE is_current")).rows;
  const policies = (await c.query("SELECT name, version, kind, body FROM policies WHERE is_current")).rows;
  const premises = (await c.query(
    "SELECT card_id, version, type, fields FROM premise_cards WHERE scenario_id = $1", [scenarioId])).rows;
  return {
    defaults: financeDefaultsOf(typeof st.industry_pack === "string" ? st.industry_pack : null),
    policyKinds: effectivePolicyKinds(st.policy_kinds ?? {}),
    skus: skus.map((r) => ({
      stable_id: String(r.stable_id), code: String(r.code), version: Number(r.version),
      unit_cost: num(r.unit_cost), unit_price: num(asObj(r.attrs)?.unit_price),
    })),
    policies: policies.map((r) => ({
      name: String(r.name), version: Number(r.version), kind: String(r.kind), body: asObj(r.body) ?? {},
    })),
    premises: premises.map((r) => ({
      card_id: String(r.card_id), version: Number(r.version), type: String(r.type), fields: asObj(r.fields) ?? {},
    })),
  };
}

async function loadCore(c: Client, scenarioId: string, runId: string | null | undefined): Promise<CoreParts | null> {
  const sc = (await c.query("SELECT id, version, status FROM scenarios WHERE id = $1 AND is_current", [scenarioId])).rows[0];
  if (!sc) return null;
  const run = runId
    ? (await c.query(
      `SELECT id, scenario_version, status, plan, started_at FROM a4_runs
        WHERE id = $1 AND scenario_id = $2 AND status IN ('feasible','partial')`, [runId, scenarioId])).rows[0]
    : (await c.query(
      `SELECT id, scenario_version, status, plan, started_at FROM a4_runs
        WHERE scenario_id = $1 AND scenario_version = $2 AND status IN ('feasible','partial')
        ORDER BY coalesce(finished_at, started_at) DESC, id DESC LIMIT 1`, [scenarioId, sc.version])).rows[0];
  const md = await masterData(c, scenarioId);
  const version = await cadastroVersionOf(c);
  let stale = false;
  if (run) {
    const facts: { scenario: { id: string; version: number; status: string }; run: RunFacts; lastPremiseChangeAt: Date | null } = {
      scenario: { id: String(sc.id), version: Number(sc.version), status: String(sc.status) },
      run: {
        id: String(run.id), scenarioId, scenarioVersion: Number(run.scenario_version), dbStatus: String(run.status),
        reasons: [], startedAt: new Date(run.started_at as string),
      },
      lastPremiseChangeAt: await lastPremiseChangeAt(c, scenarioId),
    };
    stale = runIsStale(facts);
  }
  const parts = run ? planParts(run.plan) : { served: null, legacy: false, objective: null, lines: null, period: null };
  const input: FinanceComputeInput = {
    scenarioId, scenarioVersion: run ? Number(run.scenario_version) : Number(sc.version),
    runId: run ? String(run.id) : null, cadastroVersion: version, stale,
    period: parts.period, served: run ? parts.served : null, legacyRun: !!run && parts.legacy,
    skus: md.skus, premises: md.premises, policies: md.policies, policyKinds: md.policyKinds, defaults: md.defaults,
    plan: run ? { objective: parts.objective, lines: parts.lines } : null, baseline: null,
  };
  const fin = buildScenarioFinance(input);
  return { input, mc: fin.mc.value, wc: fin.wc.total.value };
}

/**
 * ScenarioFinance do cenário corrente. runId ausente → último feasible|partial da versão corrente.
 * runId que não é esse run do cenário → null (a rota responde 404).
 */
export async function loadScenarioFinance(c: Client, scenarioId: string, opts?: { runId?: string | null }): Promise<ScenarioFinance | null> {
  const explicit = opts?.runId ?? null;
  const core = await loadCore(c, scenarioId, explicit);
  if (!core) return null;
  if (explicit && core.input.runId !== explicit) return null;
  const approved = await resolvePlanRef(c);
  let baseline: FinanceComputeInput["baseline"] = null;
  if (approved.planRef.basis === "approved" && approved.planRef.scenarioId && approved.planRef.runId) {
    if (approved.planRef.runId === core.input.runId) baseline = { mc: core.mc, wc: core.wc };
    else {
      const other = await loadCore(c, approved.planRef.scenarioId, approved.planRef.runId);
      baseline = other ? { mc: other.mc, wc: other.wc } : null;
    }
  }
  const fin = buildScenarioFinance({ ...core.input, baseline });
  assertScenarioFinance(fin);
  return fin;
}
