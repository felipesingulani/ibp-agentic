/**
 * W3 · KPI tipado — { key, label, value, unit, nullReason, source }. Nunca inventa número: sem dado → value null + nullReason.
 * Chaves do board (tenant_settings.kpi_labels): svc | cost | viol | wc. Demais chaves (visões) também seguem a forma; label nunca null.
 * Funções puras: o mesmo cálculo alimenta /api/pulse/summary e /api/visoes/:lens (teste de igualdade no DoD).
 */
import type { PlanRef } from "./plan-ref.js";
import { genericPack, getPack } from "../cadastro/packs.js";

export type NullReason =
  | "no_plan" | "no_data" | "not_computed_v0"
  | "no_price" | "no_cost" | "no_baseline" | "no_payback_in_horizon"
  | "payback_beyond_horizon" | "cost_breakdown_unavailable" | "legacy_run" | "no_policy";
export interface Kpi {
  key: string; label: string; value: number | null; unit: string | null; // label: string não vazia SEMPRE (PO+Deivid 2026-10-30)
  nullReason: NullReason | null; source: string; [extra: string]: unknown;
}
export interface PlanTotals { demand?: number; served?: number; unmet?: number; fillRate?: number | null }
export interface PlanJson { objective?: number | null; totals?: PlanTotals; utilization?: { pct: number }[] }
export interface Settings {
  currency: string | null; uom: string | null; kpi_labels: Record<string, unknown>;
  pack?: string | null;      // tenant_settings.industry_pack (NULL ≡ generic) → kpi_labels/labels.capacity do pack como 2º nível
  capacity?: string | null;  // tenant_settings.entity_labels.capacity → {cap} nos labels de utilização
}

/**
 * Labels (regra PO + Deivid 2026-10-30, W3 contract §KPI tipado): `label` é string não vazia SEMPRE — `null` proibido.
 * Precedência por key: tenant_settings.kpi_labels[key|alias] → kpi_labels[key|alias] do pack do tenant (NULL/desconhecido ≡ generic)
 * → KPI_LABEL_DEFAULTS (pt-BR; textos = KPI_CATALOG do wire 0.3.7 quando há equivalente). `{cap}` = entity_labels.capacity
 * (tenant › pack). Allowlist V0 de Visões (Deivid): demand_3p|util_avg|util_max|gaps_net|contracts_n|invest_mi|nodes_n|scenarios_n;
 * as keys que a API já emite com outro nome (nodes_current, network_gaps, …) aceitam o nome do allowlist/wire como alias.
 */
export const BOARD_KEYS = ["svc", "cost", "viol", "wc"] as const;
export const VISAO_ALLOWLIST = ["demand_3p", "util_avg", "util_max", "gaps_net", "contracts_n", "invest_mi", "nodes_n", "scenarios_n"] as const;
export const KPI_LABEL_DEFAULTS = {
  // board (= kpi_labels do pack generic)
  svc: "OTIF", cost: "Custo logístico", viol: "Violações de política", wc: "Working capital",
  // allowlist V0
  demand_3p: "Demanda dos últimos 3 períodos", util_avg: "Utilização média de {cap}", util_max: "Utilização máx. de {cap}",
  gaps_net: "Gaps de rede (capacidade)", contracts_n: "Contratos correntes", invest_mi: "Investimento em cenários correntes",
  nodes_n: "Nós correntes", scenarios_n: "Cenários de demanda",
  // keys emitidas hoje pela API (nome Task 8) — mesmos textos do allowlist/wire
  nodes_current: "Nós correntes", scenarios_sales: "Cenários de demanda", network_gaps: "Gaps de rede (capacidade)",
  contracts_current: "Contratos correntes", contract_reasons: "Restrições de contrato no plano",
  pending_alcada: "Decisões pendentes na alçada", volume_premises: "Premissas de volume (curvas de demanda)",
  adherence: "Aderência ao plano (execução)",
} as const;
export type KpiKey = keyof typeof KPI_LABEL_DEFAULTS;
const ALIASES: Partial<Record<KpiKey, string[]>> = {
  nodes_current: ["nodes_n"], scenarios_sales: ["scenarios_n", "scn_sales"], network_gaps: ["gaps_net"],
  contracts_current: ["contracts_n"], invest_mi: ["inv_mi"],
};
const pick = (m: Record<string, unknown> | undefined, keys: string[]): string | null => {
  for (const k of keys) { const v = m?.[k]; if (typeof v === "string" && v.trim()) return v.trim(); }
  return null;
};
const packOf = (s: Settings) => (s.pack && getPack(s.pack)) || genericPack();
export const labelOf = (s: Settings, key: KpiKey): string => {
  const keys = [key, ...(ALIASES[key] ?? [])];
  const pack = packOf(s);
  const raw = pick(s.kpi_labels, keys) ?? pick(pack.kpi_labels, keys) ?? KPI_LABEL_DEFAULTS[key];
  const cap = (typeof s.capacity === "string" && s.capacity.trim()) || pack.labels.capacity;
  return raw.replaceAll("{cap}", cap);
};
const kpi = (s: Settings, key: KpiKey, value: number | null, unit: string | null, nullReason: NullReason | null, source: string,
  extra: Record<string, unknown> = {}): Kpi => ({ key, label: labelOf(s, key), value, unit, nullReason: value === null ? nullReason : null, source, ...extra });
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function svcKpi(s: Settings, ref: PlanRef, plan: PlanJson | null): Kpi {
  const src = "a4_run.plan.totals.fillRate";
  if (ref.basis === "none" || !plan) return kpi(s, "svc", null, "ratio", "no_plan", src);
  return kpi(s, "svc", num(plan.totals?.fillRate), "ratio", "no_data", src);
}

export function costKpi(s: Settings, ref: PlanRef, plan: PlanJson | null): Kpi {
  const src = "a4_run.plan.objective / a4_run.plan.totals.served";
  const unit = s.currency && s.uom ? `${s.currency}/${s.uom}` : null;
  if (ref.basis === "none" || !plan) return kpi(s, "cost", null, unit, "no_plan", src);
  const obj = num(plan.objective), served = num(plan.totals?.served);
  const v = obj !== null && served !== null && served > 0 ? Math.round((obj / served) * 1e6) / 1e6 : null;
  return kpi(s, "cost", v, unit, "no_data", src);
}

export function violKpi(s: Settings, counts: { block: number; warn: number }): Kpi {
  return kpi(s, "viol", counts.block + counts.warn, "count", null, "pulse.exceptions[severity ∈ block|warn]",
    { breakdown: { block: counts.block, warn: counts.warn } });
}

/** WC do planRef. Sem run → no_plan. Com run → wc.total do ScenarioFinance (sf.v0), nunca not_computed_v0. */
export function wcKpi(s: Settings, finance: { runId: string | null; wc: { total: { value: number | null; nullReason?: NullReason | null; source: string } } } | null): Kpi {
  const unit = s.currency ? `${s.currency} mi` : null;
  if (!finance || !finance.runId) {
    return kpi(s, "wc", null, unit, "no_plan", finance?.wc.total.source ?? "sf.v0 wc.total");
  }
  const t = finance.wc.total;
  return kpi(s, "wc", t.value, unit, (t.nullReason ?? "no_data") as NullReason, t.source);
}

export function utilKpis(s: Settings, ref: PlanRef, plan: PlanJson | null): { avg: Kpi; max: Kpi } {
  const src = "a4_run.plan.utilization[].pct";
  if (ref.basis === "none" || !plan) {
    return { avg: kpi(s, "util_avg", null, "pct", "no_plan", src), max: kpi(s, "util_max", null, "pct", "no_plan", src) };
  }
  const p = (plan.utilization ?? []).map((u) => num(u.pct)).filter((x): x is number => x !== null);
  const avg = p.length ? Math.round((p.reduce((a, b) => a + b, 0) / p.length) * 10) / 10 : null;
  return { avg: kpi(s, "util_avg", avg, "pct", "no_data", src), max: kpi(s, "util_max", p.length ? Math.max(...p) : null, "pct", "no_data", src) };
}

export { kpi as makeKpi };
