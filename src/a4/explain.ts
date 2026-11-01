/**
 * W1c — explicações always-on do A4 a partir da solução (sem LLM). Saída = contracts/a4-reason.schema.json:
 * { rank, kind, summary, refs{nodeId,skuId,routeId,period}, severity }, kind ∈ janela|capacidade|contrato|custo|outro.
 *
 * Mapeamento de violações → kind (fechado no contrato; nunca "tancagem"/"rota"/"politica"/"gap"):
 *   demanda não atendida / nó no limite / nó sem capacidade → capacidade
 *   rota acima do lead time da política, déficit de nível de serviço → janela (wire: serviço cai abaixo da política)
 *   volume abaixo do mínimo / acima do máximo do contrato → contrato
 *   rota usada com custo → custo (info)
 *   Gap card aberto: fields.kind se ∈ enum ("tancagem" legado → capacidade), senão outro
 * Ordem: severity (block > warn > info), depois |impact| (custo/penalidade no objetivo). Top 3 → reasons;
 * countsByKind conta TODAS as razões candidatas.
 */
import { type ModelParams, routeIsLate, type Snapshot } from "./model.js";
import type { SolveResult } from "./solve.js";

export const REASON_KINDS = ["janela", "capacidade", "contrato", "custo", "outro"] as const;
export type ReasonKind = (typeof REASON_KINDS)[number];
export type Severity = "info" | "warn" | "block";
export interface Refs { nodeId?: string | null; skuId?: string | null; routeId?: string | null; period?: string | null }
export interface A4Reason { rank: number; kind: ReasonKind; summary: string; refs: Refs; severity: Severity }
export type CountsByKind = Record<ReasonKind, number>;

interface Candidate { kind: ReasonKind; summary: string; refs: Refs; severity: Severity; impact: number }

const EPS = 1e-6;
const SEV: Record<Severity, number> = { block: 3, warn: 2, info: 1 };
const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString("pt-BR");

/** Normaliza um kind livre (ex.: Gap card legado) para o enum do contrato. */
export function toReasonKind(k: unknown): ReasonKind {
  const s = typeof k === "string" ? k.trim().toLowerCase() : "";
  if (s === "tancagem") return "capacidade"; // legado do wire v0.2 → capacidade
  return (REASON_KINDS as readonly string[]).includes(s) ? (s as ReasonKind) : "outro";
}

export interface PlanOut {
  objective: number | null;
  solverStatus: string;
  wallMs: number;
  period: string | null;
  totals: { demand: number; served: number; unmet: number; fillRate: number | null };
  flows: { routeId: string; routeCode: string; skuId: string; skuCode: string; qty: number }[];
  local: { nodeId: string; skuId: string; qty: number }[];
  unmet: { nodeId: string; skuId: string; qty: number }[];
  utilization: { nodeId: string; code: string; used: number; capacity: number; pct: number }[];
}

export function explain(s: Snapshot, p: ModelParams, r: SolveResult): { plan: PlanOut; reasons: A4Reason[]; countsByKind: CountsByKind; candidates: number } {
  const v = (k: string) => r.values[k] ?? 0;
  const nodeCode = new Map(s.nodes.map((n) => [n.id, n.code]));
  const skuCode = new Map(s.skus.map((k) => [k.id, k.code]));
  const routeById = new Map(s.routes.map((x) => [x.id, x]));
  const period = s.period;
  const flows: PlanOut["flows"] = [], local: PlanOut["local"] = [], unmet: PlanOut["unmet"] = [];
  const used = new Map<string, number>();
  for (const [name, val] of Object.entries(r.values)) {
    if (val <= EPS) continue;
    const [t, a, b] = name.split("|");
    if (t === "x") {
      const rt = routeById.get(a)!;
      flows.push({ routeId: a, routeCode: rt.code, skuId: b, skuCode: skuCode.get(b) ?? b, qty: val });
      used.set(rt.origin, (used.get(rt.origin) ?? 0) + val);
    } else if (t === "l") { local.push({ nodeId: a, skuId: b, qty: val }); used.set(a, (used.get(a) ?? 0) + val); }
    else if (t === "u") unmet.push({ nodeId: a, skuId: b, qty: val });
  }
  const demand = s.demand.reduce((a, d) => a + Math.max(0, d.qty), 0);
  const unmetTot = unmet.reduce((a, u) => a + u.qty, 0);
  const utilization = Object.entries(s.capacity).filter(([, c]) => c > 0).map(([n, c]) => {
    const u = used.get(n) ?? 0;
    return { nodeId: n, code: nodeCode.get(n) ?? n, used: u, capacity: c, pct: Math.round((1000 * u) / c) / 10 };
  });

  const cand: Candidate[] = [];
  // capacidade: demanda não atendida (por nó; refs ao SKU de maior falta)
  const unmetByNode = new Map<string, { qty: number; topSku: string; topQty: number }>();
  for (const u of unmet) {
    const e = unmetByNode.get(u.nodeId) ?? { qty: 0, topSku: u.skuId, topQty: 0 };
    e.qty += u.qty; if (u.qty > e.topQty) { e.topQty = u.qty; e.topSku = u.skuId; }
    unmetByNode.set(u.nodeId, e);
  }
  for (const [n, e] of unmetByNode) {
    const noSource = !(s.capacity[n] > 0) && !s.routes.some((x) => x.dest === n && s.capacity[x.origin] > 0);
    cand.push({ kind: "capacidade", severity: "block", impact: e.qty * p.weights.unmet,
      summary: noSource
        ? `${nodeCode.get(n) ?? n} sem capacidade cadastrada nem origem com capacidade: ${fmt(e.qty)} un não atendidas`
        : `Demanda não atendida em ${nodeCode.get(n) ?? n}: ${fmt(e.qty)} un (capacidade das origens esgotada)`,
      refs: { nodeId: n, skuId: e.topSku, routeId: null, period } });
  }
  // capacidade: nó no limite (≥ 95%)
  for (const u of utilization) if (u.pct >= 95) {
    cand.push({ kind: "capacidade", severity: u.pct >= 99.9 ? "warn" : "info", impact: u.used,
      summary: `${u.code} a ${fmt(u.pct)}% da capacidade (${fmt(u.used)}/${fmt(u.capacity)})`,
      refs: { nodeId: u.nodeId, skuId: null, routeId: null, period } });
  }
  // janela: rota acima do lead time da política carregando fluxo
  const lateFlow = new Map<string, number>();
  for (const f of flows) if (routeIsLate(routeById.get(f.routeId)!, p)) lateFlow.set(f.routeId, (lateFlow.get(f.routeId) ?? 0) + f.qty);
  for (const [rid, q] of lateFlow) {
    const rt = routeById.get(rid)!;
    cand.push({ kind: "janela", severity: "warn", impact: q * p.weights.window,
      summary: `Rota ${rt.code} (${fmt(rt.leadTimeDays!)} d) acima do lead time da política (≤ ${fmt(p.maxLeadTimeDays!)} d): ${fmt(q)} un`,
      refs: { nodeId: rt.dest, skuId: null, routeId: rid, period } });
  }
  // janela: nível de serviço abaixo da política
  for (const [name, val] of Object.entries(r.values)) {
    if (!name.startsWith("sv|") || val <= EPS) continue;
    const n = name.slice(3);
    const D = s.demand.filter((d) => d.node === n).reduce((a, d) => a + d.qty, 0);
    const fr = D ? (D - (unmetByNode.get(n)?.qty ?? 0)) / D : 1;
    cand.push({ kind: "janela", severity: "block", impact: val * p.weights.service,
      summary: `Nível de serviço em ${nodeCode.get(n) ?? n} cai para ${fmt(fr * 100)}% (política ≥ ${fmt(p.minFillRate! * 100)}%)`,
      refs: { nodeId: n, skuId: null, routeId: null, period } });
  }
  // contrato: abaixo do mínimo / acima do máximo
  for (const c of s.contracts) {
    const lo = v(`cmin|${c.id}`), hi = v(`cmax|${c.id}`);
    if (lo > EPS) cand.push({ kind: "contrato", severity: "warn", impact: lo * p.weights.contract,
      summary: `Contrato ${c.code}: plano ${fmt(lo)} un abaixo do volume mínimo (${fmt(c.minVolume!)})`,
      refs: { nodeId: null, skuId: c.skuIds[0] ?? null, routeId: null, period } });
    if (hi > EPS) cand.push({ kind: "contrato", severity: "block", impact: hi * p.weights.contract,
      summary: `Contrato ${c.code}: plano excede o volume máximo (${fmt(c.maxVolume!)}) em ${fmt(hi)} un`,
      refs: { nodeId: null, skuId: c.skuIds[0] ?? null, routeId: null, period } });
  }
  // custo: rotas usadas com custo
  const costByRoute = new Map<string, number>();
  for (const f of flows) { const c = routeById.get(f.routeId)!.cost ?? 0; if (c > 0) costByRoute.set(f.routeId, (costByRoute.get(f.routeId) ?? 0) + c * f.qty); }
  const totalCost = [...costByRoute.values()].reduce((a, b) => a + b, 0);
  for (const [rid, c] of costByRoute) {
    const rt = routeById.get(rid)!;
    cand.push({ kind: "custo", severity: "info", impact: c,
      summary: `Rota ${rt.code} concentra ${fmt((100 * c) / totalCost)}% do custo de frete do plano (${fmt(c)})`,
      refs: { nodeId: rt.origin, skuId: null, routeId: rid, period } });
  }
  // Gap cards abertos do cenário
  for (const g of s.gapCards) {
    cand.push({ kind: toReasonKind(g.fields.kind), severity: "block", impact: p.weights.unmet,
      summary: `Gap ${g.cardId} aberto${g.nodeId ? ` em ${nodeCode.get(g.nodeId) ?? g.nodeId}` : ""}${typeof g.fields.need === "string" ? `: ${g.fields.need}` : ""}`,
      refs: { nodeId: g.nodeId, skuId: null, routeId: null, period: typeof g.fields.period === "string" ? g.fields.period : period } });
  }

  const countsByKind = Object.fromEntries(REASON_KINDS.map((k) => [k, 0])) as CountsByKind;
  for (const c of cand) countsByKind[c.kind] += 1;
  const reasons = [...cand]
    .sort((a, b) => SEV[b.severity] - SEV[a.severity] || Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 3)
    .map((c, i) => ({ rank: i + 1, kind: c.kind, summary: c.summary, refs: c.refs, severity: c.severity }));
  const served = demand - unmetTot;
  return {
    plan: { objective: r.objective, solverStatus: r.status, wallMs: r.wallMs, period,
      totals: { demand, served, unmet: unmetTot, fillRate: demand ? Math.round((10000 * served) / demand) / 10000 : null },
      flows, local, unmet, utilization },
    reasons, countsByKind, candidates: cand.length,
  };
}
