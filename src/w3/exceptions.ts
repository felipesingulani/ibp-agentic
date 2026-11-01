/**
 * W3 · /api/pulse/exceptions — A6 read stub: lista derivada (sem agente), deduplicada, ordenada block > warn > info.
 * kind/severity/refs reusam contracts/a4-reason.schema.json. source ∈ a4_run | readiness | premise_gap | alcada | execution (W4).
 *   a4_run      → reasons do run do planRef (como gravado)
 *   readiness   → itens exigidos em falta (block; kind capacidade p/ nó c/ capacidade, senão outro) + nós sem capacidade (warn)
 *                 (aviso "Gap card aberto" da prontidão não entra aqui: é a fonte premise_gap, com refs)
 *   premise_gap → cartões Gap abertos (status=gap) de cenários correntes não arquivados → capacidade/warn
 *   alcada      → itens pending_finance da fila → custo/warn; POL de alçada sem limiar (misconfigured) → outro/warn
 *   execution   → W4: buckets dia (plano × movimentos posted do run do planRef): |a−p|/p > 0.15 → warn; p>0 & a=0 → block
 *                 (kind janela|capacidade|outro; tags ["unapproved_plan"] se planRef ≠ approved) — src/execution/pulse.ts
 * Dedupe: mesmo kind + refs.nodeId/routeId (quando há ref) → fica a de maior severidade (empate: ordem das fontes acima);
 *   ids absorvidos vão em `merged`.
 */
import type { ReadinessItem, A4Readiness } from "../domain/a4Readiness.js";
import { REASON_KINDS, type ReasonKind, type Severity } from "../a4/explain.js";
import type { AlcadaView } from "./alcada.js";

export const EXCEPTION_SOURCES = ["a4_run", "readiness", "premise_gap", "alcada", "execution"] as const;
export type ExceptionSource = (typeof EXCEPTION_SOURCES)[number];
export type ExceptionAction = "open_cadastro" | "open_scenario" | "rerun_a4" | "alcada_queue" | "publish_alcada";
export interface Refs { nodeId: string | null; skuId: string | null; routeId: string | null; period: string | null }
export interface PulseException {
  id: string; source: ExceptionSource; kind: ReasonKind; severity: Severity; summary: string; refs: Refs;
  scenarioId: string | null; action: ExceptionAction; merged: string[];
  tags?: string[]; // W4: execution → ["unapproved_plan"] quando planRef não é aprovado
}
export const SEVERITIES = ["block", "warn", "info"] as const;
const SEV: Record<Severity, number> = { block: 0, warn: 1, info: 2 };
const SRC: Record<ExceptionSource, number> = { a4_run: 0, readiness: 1, premise_gap: 2, alcada: 3, execution: 4 };

const refsOf = (r: Partial<Refs> | null | undefined): Refs => ({
  nodeId: r?.nodeId ?? null, skuId: r?.skuId ?? null, routeId: r?.routeId ?? null, period: r?.period ?? null,
});
const asKind = (k: unknown): ReasonKind => ((REASON_KINDS as readonly string[]).includes(k as string) ? (k as ReasonKind) : "outro");
const asSev = (s: unknown): Severity => (s === "block" || s === "warn" || s === "info" ? s : "warn");

export interface ExceptionFacts {
  run: { id: string; scenarioId: string; reasons: unknown[] } | null;
  readiness: A4Readiness;
  gapCards: { id: string; cardId: string; scenarioId: string; nodeId: string | null; nodeCode: string | null; need: string | null }[];
  nodeCodes: Map<string, string>;
  alcada: AlcadaView;
  execution?: PulseException[]; // W4: já derivadas por src/execution/pulse.ts (buckets dia × limiar 15%)
}

export function buildExceptions(f: ExceptionFacts): PulseException[] {
  const out: PulseException[] = [];
  if (f.run) {
    for (const [i, r] of (f.run.reasons as Record<string, unknown>[]).entries()) {
      out.push({ id: `a4_run:${f.run.id}:${(r.rank as number) ?? i + 1}`, source: "a4_run", kind: asKind(r.kind), severity: asSev(r.severity),
        summary: String(r.summary ?? "Razão do A4"), refs: refsOf(r.refs as Partial<Refs>), scenarioId: f.run.scenarioId,
        action: "open_scenario", merged: [] });
    }
  }
  for (const it of f.readiness.items.filter((x: ReadinessItem) => x.required && x.status === "falta")) {
    out.push({ id: `readiness:${it.key}`, source: "readiness", kind: it.key === "node_capacity" ? "capacidade" : "outro",
      severity: "block", summary: `Falta: ${it.label}`, refs: refsOf(null), scenarioId: null, action: "open_cadastro", merged: [] });
  }
  for (const w of f.readiness.warnings.filter((x) => x.kind === "node_without_capacity")) {
    for (const n of w.by) {
      out.push({ id: `readiness:node_without_capacity:${n}`, source: "readiness", kind: "capacidade", severity: "warn",
        summary: `${f.nodeCodes.get(n) ?? n}: nó publicado sem capacidade corrente`, refs: refsOf({ nodeId: n }),
        scenarioId: null, action: "open_cadastro", merged: [] });
    }
  }
  for (const g of f.gapCards) {
    out.push({ id: `premise_gap:${g.id}`, source: "premise_gap", kind: "capacidade", severity: "warn",
      summary: `Gap ${g.cardId} aberto${g.nodeCode ? ` em ${g.nodeCode}` : ""}${g.need ? `: ${g.need}` : ""}`,
      refs: refsOf({ nodeId: g.nodeId }), scenarioId: g.scenarioId, action: "open_scenario", merged: [] });
  }
  if (f.alcada.mode === "misconfigured" && f.alcada.policy) {
    out.push({ id: `alcada:misconfigured:${f.alcada.policy.id}`, source: "alcada", kind: "outro", severity: "warn",
      summary: "Política de alçada sem limiar válido (body.limitMi): todo investimento passa pela Finance",
      refs: refsOf(null), scenarioId: null, action: "open_cadastro", merged: [] });
  }
  if (f.alcada.mode === "no_policy" && f.alcada.needsPolicy > 0) { // W3b: fail-closed até publicar
    out.push({ id: "alcada:no_policy", source: "alcada", kind: "outro", severity: "warn",
      summary: `Sem política de alçada publicada: ${f.alcada.needsPolicy} cenário(s) com investimento exigem Finance`,
      refs: refsOf(null), scenarioId: null, action: "publish_alcada", merged: [] });
  }
  for (const q of f.alcada.items.filter((x) => x.status === "pending_finance")) {
    const imp = q.impactMi === null ? "investimento sem valor legível" : `investimento ${q.impactMi} mi`;
    out.push({ id: `alcada:${q.id}`, source: "alcada", kind: "custo", severity: "warn",
      summary: `${q.name} v${q.scenarioVersion}: ${imp} > alçada ${q.alcadaMi} mi — aguarda Finance`,
      refs: refsOf(null), scenarioId: q.scenarioId, action: "alcada_queue", merged: [] });
  }
  out.push(...(f.execution ?? []));
  return dedupe(out);
}

export function dedupe(list: PulseException[]): PulseException[] {
  const sorted = [...list].sort((a, b) => SEV[a.severity] - SEV[b.severity] || SRC[a.source] - SRC[b.source]);
  const byKey = new Map<string, PulseException>();
  for (const e of sorted) {
    // W4: execução é por bucket DIA → dia entra na chave (dias distintos no mesmo nó não se fundem)
    const day = e.source === "execution" ? `|${e.refs.period ?? ""}` : "";
    const key = e.refs.nodeId || e.refs.routeId ? `${e.kind}|${e.refs.nodeId ?? ""}|${e.refs.routeId ?? ""}${day}` : `id|${e.id}`;
    const kept = byKey.get(key);
    if (kept) kept.merged.push(e.id); else byKey.set(key, { ...e, merged: [...e.merged] });
  }
  return [...byKey.values()].sort((a, b) =>
    SEV[a.severity] - SEV[b.severity] || SRC[a.source] - SRC[b.source] || a.id.localeCompare(b.id));
}

export const severityCounts = (list: PulseException[]) => ({
  block: list.filter((e) => e.severity === "block").length,
  warn: list.filter((e) => e.severity === "warn").length,
  info: list.filter((e) => e.severity === "info").length,
});
