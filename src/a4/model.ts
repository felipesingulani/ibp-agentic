/**
 * W1c — modelo piloto do A4 (fluxo rota×SKU, 1 período, 1 escalão). Sem LLM, sem write-back.
 *
 * Snapshot (cadastro corrente do tenant sob RLS + cenário): nós, node_capacity, rotas, SKUs, demanda
 * (sales_history do último período), políticas, contratos (se supply externo no escopo), Gap cards do cenário.
 *
 * Variáveis (≥ 0):
 *   x|r|s  fluxo na rota r do SKU s (só se o destino tem demanda de s e a origem tem capacidade)
 *   l|n|s  atendimento local no nó n (se n tem capacidade e demanda de s)
 *   u|n|s  demanda não atendida (penalidade weights.unmet)
 *   sv|n   déficit de serviço vs política (soft, weights.service)
 *   cmin|c / cmax|c  desvio de volume mínimo/máximo do contrato (soft, weights.contract)
 * Restrições:
 *   dem|n|s : Σ x(→n,s) + l(n,s) + u(n,s) = demanda(n,s)
 *   cap|n   : Σ x(n→,·) + Σ l(n,·) ≤ capacidade(n)    (node_capacity corrente — hard)
 *   svc|n   : Σ u(n,·) − sv(n) ≤ (1 − min_fill_rate) · demanda(n)
 *   ctmin|c : Σ fluxo SKUs do contrato + cmin(c) ≥ obligations.min_volume
 *   ctmax|c : Σ fluxo SKUs do contrato − cmax(c) ≤ obligations.max_volume
 * Políticas que alimentam o modelo = kinds dos grupos working_capital|inventory|service do vocabulário do tenant
 * (tenant_settings.policy_kinds → Snapshot.policyKinds; {}/ausente → legado), o mesmo da prontidão/alçada (F-1, W5).
 * Objetivo: min Σ custo_rota·x + penalidades. Rota com lead_time_days > política max_lead_time_days paga
 * weights.window por unidade (janela). Pesos = defaults genéricos, sobrescritos por body.weights da
 * política de serviço/estoque do tenant ou pelo POST — nunca por vertical.
 */
import { type EffectivePolicyKinds, effectivePolicyKinds, inKindGroup } from "../domain/policy-kinds.js";

export const PILOT_LIMITS = { nodes: 50, skus: 50, routes: 500 } as const;

export interface Weights { unmet: number; service: number; contract: number; window: number }
export const DEFAULT_WEIGHTS: Weights = { unmet: 1000, service: 200, contract: 100, window: 5 };

export interface Snapshot {
  scenario: { id: string; version: number; code: string };
  period: string | null;
  nodes: { id: string; code: string }[];
  capacity: Record<string, number>; // node stable_id → capacity_per_period
  routes: { id: string; code: string; origin: string; dest: string; cost: number | null; leadTimeDays: number | null }[];
  skus: { id: string; code: string }[];
  demand: { node: string; sku: string; qty: number }[];
  policies: { id: string; kind: string; body: Record<string, unknown> }[];
  contracts: { id: string; code: string; skuIds: string[]; minVolume: number | null; maxVolume: number | null }[];
  gapCards: { id: string; cardId: string; nodeId: string | null; fields: Record<string, unknown> }[];
  /** F-1: vocabulário efetivo de policies.kind do tenant (effectivePolicyKinds(tenant_settings.policy_kinds)). Ausente → legado. */
  policyKinds?: EffectivePolicyKinds;
}

export interface LpVar { name: string; lb: number; ub: number | null; obj: number }
export interface LpCon { name: string; lb: number | null; ub: number | null; coefs: Record<string, number> }
export interface LpModel { vars: LpVar[]; cons: LpCon[]; timeLimitMs: number }

export interface ModelParams { minFillRate: number | null; maxLeadTimeDays: number | null; weights: Weights }

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const MODEL_GROUPS = ["service", "inventory", "working_capital"] as const;

/** Parâmetros soft vindos das políticas correntes (chaves genéricas em policies.body). */
export function paramsFrom(s: Snapshot, override?: Partial<Weights>): ModelParams {
  const kinds = s.policyKinds ?? effectivePolicyKinds({});
  const svc = s.policies.filter((p) => MODEL_GROUPS.some((g) => inKindGroup(kinds, p.kind, g)));
  let minFillRate: number | null = null, maxLeadTimeDays: number | null = null;
  let weights = { ...DEFAULT_WEIGHTS };
  for (const p of svc) {
    const fr = num(p.body.min_fill_rate);
    if (fr !== null && fr >= 0 && fr <= 1) minFillRate = Math.max(minFillRate ?? 0, fr);
    const lt = num(p.body.max_lead_time_days);
    if (lt !== null && lt >= 0) maxLeadTimeDays = Math.min(maxLeadTimeDays ?? Infinity, lt);
    const w = p.body.weights;
    if (w && typeof w === "object") weights = { ...weights, ...cleanWeights(w as Record<string, unknown>) };
  }
  if (override) weights = { ...weights, ...cleanWeights(override as Record<string, unknown>) };
  return { minFillRate, maxLeadTimeDays, weights };
}

function cleanWeights(w: Record<string, unknown>): Partial<Weights> {
  const out: Partial<Weights> = {};
  for (const k of ["unmet", "service", "contract", "window"] as const) {
    const v = num(w[k]);
    if (v !== null && v >= 0) out[k] = v;
  }
  return out;
}

export const routeIsLate = (r: Snapshot["routes"][number], p: ModelParams) =>
  p.maxLeadTimeDays !== null && r.leadTimeDays !== null && r.leadTimeDays > p.maxLeadTimeDays;

export function checkPilotLimits(s: Snapshot): string | null {
  if (s.nodes.length > PILOT_LIMITS.nodes) return `pilot_limit: ${s.nodes.length} nós > ${PILOT_LIMITS.nodes}`;
  if (s.skus.length > PILOT_LIMITS.skus) return `pilot_limit: ${s.skus.length} SKUs > ${PILOT_LIMITS.skus}`;
  if (s.routes.length > PILOT_LIMITS.routes) return `pilot_limit: ${s.routes.length} rotas > ${PILOT_LIMITS.routes}`;
  return null;
}

export function buildModel(s: Snapshot, p: ModelParams, timeLimitMs = 5000): LpModel {
  const vars: LpVar[] = [];
  const cons: LpCon[] = [];
  const add = (name: string, obj = 0, ub: number | null = null) => { vars.push({ name, lb: 0, ub, obj }); return name; };
  const hasCap = (n: string) => (s.capacity[n] ?? 0) > 0;
  const capRows = new Map<string, Record<string, number>>();
  const capRow = (n: string) => { if (!capRows.has(n)) capRows.set(n, {}); return capRows.get(n)!; };
  const flowBySku = new Map<string, string[]>(); // sku → vars x/l
  const pushFlow = (sku: string, v: string) => { if (!flowBySku.has(sku)) flowBySku.set(sku, []); flowBySku.get(sku)!.push(v); };
  const demandByNode = new Map<string, number>();
  const unmetByNode = new Map<string, string[]>();

  for (const d of s.demand) {
    if (!(d.qty > 0)) continue;
    const coefs: Record<string, number> = {};
    for (const r of s.routes) {
      if (r.dest !== d.node || r.origin === d.node || !hasCap(r.origin)) continue;
      const late = routeIsLate(r, p);
      const x = add(`x|${r.id}|${d.sku}`, (r.cost ?? 0) + (late ? p.weights.window : 0));
      coefs[x] = 1; capRow(r.origin)[x] = 1; pushFlow(d.sku, x);
    }
    if (hasCap(d.node)) {
      const l = add(`l|${d.node}|${d.sku}`);
      coefs[l] = 1; capRow(d.node)[l] = 1; pushFlow(d.sku, l);
    }
    const u = add(`u|${d.node}|${d.sku}`, p.weights.unmet);
    coefs[u] = 1;
    cons.push({ name: `dem|${d.node}|${d.sku}`, lb: d.qty, ub: d.qty, coefs });
    demandByNode.set(d.node, (demandByNode.get(d.node) ?? 0) + d.qty);
    unmetByNode.set(d.node, [...(unmetByNode.get(d.node) ?? []), u]);
  }
  for (const [n, coefs] of capRows) cons.push({ name: `cap|${n}`, lb: null, ub: s.capacity[n], coefs });

  if (p.minFillRate !== null) {
    for (const [n, D] of demandByNode) {
      const sv = add(`sv|${n}`, p.weights.service);
      const coefs: Record<string, number> = { [sv]: -1 };
      for (const u of unmetByNode.get(n)!) coefs[u] = 1;
      cons.push({ name: `svc|${n}`, lb: null, ub: (1 - p.minFillRate) * D, coefs });
    }
  }
  for (const c of s.contracts) {
    const fl = c.skuIds.flatMap((k) => flowBySku.get(k) ?? []);
    if (c.minVolume !== null && c.minVolume > 0) {
      const v = add(`cmin|${c.id}`, p.weights.contract);
      cons.push({ name: `ctmin|${c.id}`, lb: c.minVolume, ub: null, coefs: { ...Object.fromEntries(fl.map((f) => [f, 1])), [v]: 1 } });
    }
    if (c.maxVolume !== null && fl.length) {
      const v = add(`cmax|${c.id}`, p.weights.contract);
      cons.push({ name: `ctmax|${c.id}`, lb: null, ub: c.maxVolume, coefs: { ...Object.fromEntries(fl.map((f) => [f, 1])), [v]: -1 } });
    }
  }
  return { vars, cons, timeLimitMs };
}
