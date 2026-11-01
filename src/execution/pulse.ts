/**
 * W4 · Task 10 — regras puras de execução → Pulse (docs/architecture/W4-EXECUTION-PULSE-WRITE-CONTRACT.md).
 * Cravos PO 2026-10-30: bucket = DIA · limiar 15% FIXO (constante V0; settings/pack depois).
 *   bucket   = (period_start, kind, node_id, sku_id) dos movimentos `posted` do run do planRef
 *   planned  = Σ qty_planned das linhas com planned (todas null → null: sem base, sem exceção — nunca inventar)
 *   block    = planned > 0 e actual = 0 · warn = |actual − planned| / planned > 0.15 · planned 0/null → nada
 *   kind     → a4-reason: ship/receive/transfer → janela (atraso de janela) · produce → capacidade · other → outro
 *   adherence = 1 − Σ|a − p| / Σp nos buckets com planned, janela curta = 7 dias terminando no maior period_start
 * Determinístico, sem rede e sem agente.
 */
import type { ReasonKind } from "../a4/explain.js";
import type { PlanBasis } from "../w3/plan-ref.js";
import type { PulseException } from "../w3/exceptions.js";

export const EXEC_THRESHOLD = 0.15;
export const EXEC_WINDOW_DAYS = 7;
export const MOVEMENT_KINDS = ["ship", "receive", "produce", "transfer", "other"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];
export interface MovementFact {
  periodStart: string; kind: MovementKind; nodeId: string | null; skuId: string | null; qtyPlanned: number | null; qtyActual: number;
}
export interface Bucket {
  periodStart: string; kind: MovementKind; nodeId: string | null; skuId: string | null;
  planned: number | null; actual: number; rows: number;
}

const REASON: Record<MovementKind, ReasonKind> = { ship: "janela", receive: "janela", transfer: "janela", produce: "capacidade", other: "outro" };
const LABEL: Record<MovementKind, string> = { ship: "expedição", receive: "recebimento", produce: "produção", transfer: "transferência", other: "movimento" };
export const kindToReason = (k: MovementKind): ReasonKind => REASON[k];
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function bucketize(ms: MovementFact[]): Bucket[] {
  const by = new Map<string, Bucket>();
  for (const m of ms) {
    const key = [m.periodStart, m.kind, m.nodeId ?? "", m.skuId ?? ""].join("|");
    const b = by.get(key) ?? { periodStart: m.periodStart, kind: m.kind, nodeId: m.nodeId, skuId: m.skuId, planned: null, actual: 0, rows: 0 };
    b.actual = r6(b.actual + m.qtyActual);
    if (m.qtyPlanned !== null) b.planned = r6((b.planned ?? 0) + m.qtyPlanned);
    b.rows++;
    by.set(key, b);
  }
  return [...by.values()].sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.kind.localeCompare(b.kind)
    || (a.nodeId ?? "").localeCompare(b.nodeId ?? "") || (a.skuId ?? "").localeCompare(b.skuId ?? ""));
}

export interface ExecCtx { runId: string; scenarioId: string; basis: PlanBasis; nodeCodes: Map<string, string> }

export function executionExceptions(buckets: Bucket[], ctx: ExecCtx): PulseException[] {
  const out: PulseException[] = [];
  for (const b of buckets) {
    if (b.planned === null || b.planned <= 0) continue;
    const dev = Math.abs(b.actual - b.planned) / b.planned;
    const severity = b.actual === 0 ? "block" : dev > EXEC_THRESHOLD ? "warn" : null;
    if (!severity) continue;
    const where = b.nodeId ? ctx.nodeCodes.get(b.nodeId) ?? b.nodeId : "rede";
    const pct = Math.round(((b.actual - b.planned) / b.planned) * 1000) / 10;
    out.push({
      id: `execution:${ctx.runId}:${b.periodStart}:${b.kind}:${b.nodeId ?? "-"}:${b.skuId ?? "-"}`,
      source: "execution", kind: kindToReason(b.kind), severity,
      summary: `${where} ${b.periodStart} · ${LABEL[b.kind]}: realizado ${b.actual} vs programado ${b.planned} (${pct > 0 ? "+" : ""}${pct}%)`,
      refs: { nodeId: b.nodeId, skuId: b.skuId, routeId: null, period: b.periodStart },
      scenarioId: ctx.scenarioId, action: "open_scenario", merged: [],
      tags: ctx.basis === "approved" ? [] : ["unapproved_plan"],
    });
  }
  return out;
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export function adherence(buckets: Bucket[]): { value: number | null; from: string | null; to: string | null; buckets: number } {
  const withPlan = buckets.filter((b) => b.planned !== null);
  if (!withPlan.length) return { value: null, from: null, to: null, buckets: 0 };
  const to = withPlan.map((b) => b.periodStart).sort().at(-1)!;
  const from = addDays(to, -(EXEC_WINDOW_DAYS - 1));
  const win = withPlan.filter((b) => b.periodStart >= from && b.periodStart <= to);
  const sp = win.reduce((a, b) => a + b.planned!, 0);
  if (sp <= 0) return { value: null, from, to, buckets: win.length };
  const dev = win.reduce((a, b) => a + Math.abs(b.actual - b.planned!), 0);
  return { value: Math.round((1 - dev / sp) * 1e4) / 1e4, from, to, buckets: win.length };
}
