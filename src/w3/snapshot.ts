/**
 * W3 · snapshot por request — UMA leitura (sob RLS, só SELECT) alimenta /pulse/summary, /pulse/exceptions,
 * /alcada/queue e /visoes/:lens. Regra de verdade única: um número que aparece em mais de um lugar sai daqui,
 * da mesma função e do mesmo planRef (teste de igualdade summary × lentes).
 * Empty tenant nunca inventa número: sem run → KPIs null + nullReason; contagens só de query real (0 real ≠ null).
 */
import type { Client } from "../db/pool.js";
import type { Row } from "../http/common.js";
import { computeReadiness, loadReadinessFacts, type A4Readiness } from "../domain/a4Readiness.js";
import { runIsStale } from "../a7/decision.js";
import { lastPremiseChangeAt } from "../a7/premise-change.js";
import { type AlcadaView, loadAlcadaQueue, scenarioImpact } from "./alcada.js";
import { type PlanRef, resolvePlanRef } from "./plan-ref.js";
import { type Bucket, adherence, bucketize, executionExceptions } from "../execution/pulse.js";
import { loadPlanMovements } from "../execution/store.js";
import { type PulseException, buildExceptions, severityCounts } from "./exceptions.js";
import {
  type Kpi, type PlanJson, type Settings, costKpi, makeKpi, svcKpi, utilKpis, violKpi, wcKpi,
} from "./kpi.js";

export const LENSES = ["sales", "supply", "finance"] as const;
export type Lens = (typeof LENSES)[number];

export interface W3Snapshot {
  settings: Settings; confirmedAt: string | null;
  planRef: PlanRef; run: Row | null; plan: PlanJson | null;
  readiness: A4Readiness; unlock: { newScenario: boolean };
  scenarios: Row[]; nodes: Row[]; cards: Row[]; contractsCurrent: number;
  demand3p: { value: number | null; periods: string[] };
  alcada: AlcadaView; exceptions: PulseException[]; staleScenarios: number;
  execution: { movements: number; buckets: Bucket[]; flagged: number; adherence: ReturnType<typeof adherence> }; // W4
}

const live = (s: Row) => s.is_current && s.status !== "archived";

export async function loadW3(c: Client): Promise<W3Snapshot> {
  const st = (await c.query("SELECT currency, uom, kpi_labels, confirmed_at, industry_pack, entity_labels FROM tenant_settings")).rows[0] ?? null;
  const settings: Settings = { currency: st?.currency ?? null, uom: st?.uom ?? null, kpi_labels: (st?.kpi_labels ?? {}) as Record<string, unknown>,
    pack: st?.industry_pack ?? null, capacity: typeof st?.entity_labels?.capacity === "string" ? st.entity_labels.capacity : null };
  const confirmedAt = st?.confirmed_at ? new Date(st.confirmed_at).toISOString() : null;
  const { planRef, run } = await resolvePlanRef(c);
  const readiness = computeReadiness(await loadReadinessFacts(c));
  const unlock = { newScenario: confirmedAt !== null && readiness.state !== "block" };

  const scenarios = (await c.query("SELECT * FROM scenarios ORDER BY created_at, id")).rows;
  const liveIds = scenarios.filter(live).map((s) => String(s.id));
  const nodes = (await c.query("SELECT id, stable_id, code FROM nodes WHERE is_current ORDER BY code")).rows;
  const cards = liveIds.length
    ? (await c.query("SELECT * FROM premise_cards WHERE scenario_id = ANY($1::uuid[]) ORDER BY created_at, id", [liveIds])).rows : [];
  const contractsCurrent = Number((await c.query("SELECT count(*)::int AS n FROM supplier_contracts WHERE is_current")).rows[0].n);

  const per = (await c.query(
    `SELECT period, sum(qty)::float8 AS q FROM sales_history
      WHERE period IN (SELECT DISTINCT period FROM sales_history ORDER BY period DESC LIMIT 3)
      GROUP BY period ORDER BY period`)).rows;
  const demand3p = { value: per.length ? per.reduce((a, r) => a + Number(r.q), 0) : null, periods: per.map((r) => String(r.period)) };

  const alcada = await loadAlcadaQueue(c);

  const nodeCodes = new Map<string, string>();
  for (const n of nodes) { nodeCodes.set(String(n.stable_id), String(n.code)); nodeCodes.set(String(n.id), String(n.code)); }
  const gapCards = cards.filter((k) => k.type === "Gap" && k.status === "gap").map((k) => {
    const f = (k.fields ?? {}) as Record<string, unknown>;
    const nodeId = k.node_id ? String(k.node_id) : null;
    return { id: String(k.id), cardId: String(k.card_id), scenarioId: String(k.scenario_id), nodeId,
      nodeCode: nodeId ? nodeCodes.get(nodeId) ?? null : null, need: typeof f.need === "string" ? f.need : null };
  });
  // W4: execução do run do planRef (posted) → buckets dia → exceções (limiar 15% fixo) + aderência. Sem movimentos → nada inventado.
  const movs = run ? await loadPlanMovements(c, String(run.id)) : [];
  const buckets = bucketize(movs);
  const execExc = run ? executionExceptions(buckets, { runId: String(run.id), scenarioId: String(run.scenario_id), basis: planRef.basis, nodeCodes }) : [];
  const execution = { movements: movs.length, buckets, flagged: execExc.length, adherence: adherence(buckets) };
  const exceptions = buildExceptions({
    run: run ? { id: String(run.id), scenarioId: String(run.scenario_id), reasons: (run.reasons ?? []) as unknown[] } : null,
    readiness, gapCards, nodeCodes, alcada, execution: execExc,
  });

  // cenários stale: corrente não arquivado com status stale, ou cujo último run done ficou stale (mesma regra do POST A7)
  let staleScenarios = 0;
  for (const s of scenarios.filter(live)) {
    if (s.status === "stale") { staleScenarios++; continue; }
    const r = (await c.query(
      `SELECT * FROM a4_runs WHERE scenario_id = $1 AND status IN ('feasible','partial')
        ORDER BY coalesce(finished_at, started_at) DESC, id DESC LIMIT 1`, [s.id])).rows[0];
    if (!r) continue;
    const runF = { id: String(r.id), scenarioId: String(r.scenario_id), scenarioVersion: Number(r.scenario_version),
      dbStatus: String(r.status), reasons: [], startedAt: new Date(r.started_at) };
    if (runIsStale({ scenario: { id: String(s.id), version: Number(s.version), status: String(s.status) }, run: runF,
      lastPremiseChangeAt: await lastPremiseChangeAt(c, String(s.id)) })) staleScenarios++;
  }

  return { settings, confirmedAt, planRef, run, plan: (run?.plan ?? null) as PlanJson | null, readiness, unlock,
    scenarios, nodes, cards, contractsCurrent, demand3p, alcada, exceptions, staleScenarios, execution };
}

// ---- números compartilhados (uma função cada) ----
export const pendingAlcada = (s: W3Snapshot) => s.alcada.items.filter((i) => i.status === "pending_finance").length;

/** W4: aderência realizado × programado (1 − Σ|a−p|/Σp, janela 7 dias) — null + no_plan|no_data sem base. */
export const adherenceKpi = (s: W3Snapshot): Kpi => makeKpi(s.settings, "adherence", s.execution.adherence.value, "ratio",
  s.planRef.basis === "none" ? "no_plan" : "no_data",
  "execution_movements[posted, run do planRef] · 1 − Σ|actual−planned|/Σplanned (7 dias)",
  { from: s.execution.adherence.from, to: s.execution.adherence.to, buckets: s.execution.adherence.buckets });

export function pulseKpis(s: W3Snapshot): Kpi[] {
  return [svcKpi(s.settings, s.planRef, s.plan), costKpi(s.settings, s.planRef, s.plan),
    violKpi(s.settings, severityCounts(s.exceptions)), wcKpi(s.settings)];
}
const kpiByKey = (s: W3Snapshot, key: string) => pulseKpis(s).find((k) => k.key === key)!;

export const demand3pKpi = (s: W3Snapshot): Kpi => makeKpi(s.settings, "demand_3p", s.demand3p.value, s.settings.uom, "no_data",
  "sales_history.qty (últimos 3 períodos)", { periods: s.demand3p.periods });
export const pendingAlcadaKpi = (s: W3Snapshot): Kpi => makeKpi(s.settings, "pending_alcada", pendingAlcada(s), "count", null,
  "alcada.queue[status=pending_finance]", { mode: s.alcada.mode });

export interface NextStep { key: string; label: string; cta: string; scenarioId?: string }
const READINESS_CTA: Record<string, string> = {
  node_capacity: "Cadastrar nó com capacidade", sku: "Cadastrar SKU", policy: "Cadastrar política", route: "Cadastrar rota", supplier_contract: "Cadastrar contrato",
};
export function nextStep(s: W3Snapshot): NextStep {
  if (!s.settings.currency || !s.settings.uom) return { key: "config", label: "Configurar moeda e unidade do tenant", cta: "Configurar" };
  const miss = s.readiness.items.find((i) => i.required && i.status === "falta");
  if (miss) return { key: `readiness:${miss.key}`, label: `Falta: ${miss.label}`, cta: READINESS_CTA[miss.key] ?? "Abrir cadastro" };
  if (!s.confirmedAt) return { key: "confirm", label: "Confirmar cadastro para liberar cenários", cta: "Confirmar cadastro" };
  if (!s.scenarios.some(live)) return { key: "new_scenario", label: "Criar o primeiro cenário", cta: "Novo cenário" };
  if (s.planRef.basis === "none") {
    const sc = s.scenarios.filter(live).at(-1)!;
    return { key: "run_a4", label: "Rodar o A4 no cenário", cta: "Rodar A4", scenarioId: String(sc.id) };
  }
  if (s.alcada.mode === "no_policy" && s.alcada.needsPolicy > 0) // W3b: pack com alçada sem POL → fail-closed
    return { key: "publish_alcada", label: "Publicar a política de alçada (Investimento exige Finance até lá)", cta: "Publicar alçada" };
  if (pendingAlcada(s) > 0) return { key: "alcada_queue", label: "Decisões aguardando a Finance (alçada)", cta: "Abrir fila de alçada" };
  if (s.planRef.basis === "latest_run") {
    return { key: "decide", label: "Plano não aprovado: aprovar ou escalar", cta: "Decidir", scenarioId: s.planRef.scenarioId! };
  }
  return { key: "none", label: "Plano aprovado vigente", cta: "Ver plano" };
}

export function pulseSummary(s: W3Snapshot) {
  const { state, met, need, items } = s.readiness;
  return { planRef: s.planRef, kpis: pulseKpis(s), readiness: { state, met, need, items }, unlock: s.unlock,
    pending: { alcada: pendingAlcada(s), staleScenarios: s.staleScenarios, executionExceptions: s.execution.flagged },
    execution: { movements: s.execution.movements, adherence: adherenceKpi(s) }, // W4
    empty: s.planRef.basis === "none", nextStep: nextStep(s) };
}

export function lensView(s: W3Snapshot, lens: Lens) {
  const util = utilKpis(s.settings, s.planRef, s.plan);
  const base = { lens, planRef: s.planRef, empty: s.planRef.basis === "none", nextStep: nextStep(s) };
  const liveSc = s.scenarios.filter(live);
  if (lens === "sales") {
    const sales = liveSc.filter((x) => x.leg === "sales");
    const byStatus: Record<string, number> = {};
    for (const x of sales) byStatus[String(x.status)] = (byStatus[String(x.status)] ?? 0) + 1;
    return { ...base,
      cards: [demand3pKpi(s), makeKpi(s.settings, "nodes_current", s.nodes.length, "count", null, "nodes[is_current]"),
        makeKpi(s.settings, "scenarios_sales", sales.length, "count", null, "scenarios[leg=sales, corrente, não arquivado]", { byStatus })],
      cross: [kpiByKey(s, "svc"), util.max, pendingAlcadaKpi(s)],
      action: { kind: "new_scenario", enabled: s.unlock.newScenario,
        disabledReason: s.unlock.newScenario ? null : s.readiness.state === "block" ? "a4_not_ready" : "not_confirmed" } };
  }
  if (lens === "supply") {
    const gaps = s.exceptions.filter((e) => e.source === "premise_gap" || e.id.startsWith("readiness:node_without_capacity:"));
    const run = s.run;
    const contrato = run ? Number(((run.counts_by_kind ?? {}) as Record<string, number>).contrato ?? 0) : null;
    const target = s.planRef.scenarioId ?? (liveSc.at(-1)?.id ? String(liveSc.at(-1)!.id) : null);
    return { ...base,
      cards: [util.avg, util.max,
        makeKpi(s.settings, "network_gaps", gaps.length, "count", null, "pulse.exceptions[premise_gap + nó sem capacidade]"),
        makeKpi(s.settings, "contracts_current", s.contractsCurrent, "count", null, "supplier_contracts[is_current]"),
        makeKpi(s.settings, "contract_reasons", contrato, "count", "no_plan", "a4_run.counts_by_kind.contrato")],
      cross: [demand3pKpi(s), kpiByKey(s, "cost")],
      action: { kind: "register_gap", enabled: !!target && s.nodes.length > 0,
        disabledReason: !target ? "no_scenario" : s.nodes.length ? null : "no_nodes", ...(target ? { scenarioId: target } : {}) } };
  }
  // finance
  const inv = new Map<string, Row[]>();
  for (const k of s.cards.filter((x) => x.type === "Investimento")) inv.set(String(k.scenario_id), [...(inv.get(String(k.scenario_id)) ?? []), k]);
  let sum = 0, unreadable = 0;
  for (const cs of inv.values()) {
    const imp = scenarioImpact(cs.map((k) => ({ type: String(k.type), fields: k.fields })));
    if (imp.impactMi === null) unreadable++; else sum += imp.impactMi;
  }
  const n = pendingAlcada(s);
  return { ...base,
    cards: [kpiByKey(s, "wc"),
      makeKpi(s.settings, "invest_mi", Math.round(sum * 1e6) / 1e6, s.settings.currency ? `${s.settings.currency} mi` : null, null,
        "premise_cards[type=Investimento].fields.impactMi (cenários correntes)", { scenarios: inv.size, unreadableScenarios: unreadable }),
      pendingAlcadaKpi(s)],
    cross: [makeKpi(s.settings, "volume_premises", s.cards.filter((x) => x.type === "CurvaDemanda").length, "count", null,
      "premise_cards[type=CurvaDemanda] (cenários correntes)"), kpiByKey(s, "cost")],
    action: { kind: "alcada_queue", enabled: (s.alcada.mode === "active" || s.alcada.mode === "misconfigured") && n > 0, count: n,
      disabledReason: s.alcada.mode === "out_of_pack" || s.alcada.mode === "no_policy" ? s.alcada.mode : n > 0 ? null : "no_pending" } };
}
