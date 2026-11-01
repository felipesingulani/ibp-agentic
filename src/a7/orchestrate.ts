/**
 * T-A7-LEVE — A7 orchestrator leve (docs/architecture/A7-ORCHESTRATOR-LEVE-CONTRACT.md §4–§7). Função PURA:
 * fatos (snapshot W3 + fatos A7 de decision.ts + alçada de w3/alcada.ts) → veredito + provocations stub + pacote mínimo.
 * Máquina determinística `state_machine_only`: sem rede, sem texto gerado, sem solver (A4 nunca é provocado nem disparado).
 *
 * Veredito (ordem fixa, §4; 404/archived/a7_disabled são tratados antes, na rota):
 *   await_inputs   ← sem run feasible|partial na versão corrente · runStale · readiness.state=block · exception block source=readiness
 *   escalate_human ← requiresFinance · exception block (qualquer fonte restante) · run partial · reason warn|block · decisionState=escalated
 *   auto_policy    ← decisionState=pending ∧ run feasible ∧ ¬stale ∧ ¬requiresFinance ∧ 0 block ∧ 0 reasons warn|block
 *   Fallback (decisionState=approved sem nenhuma condição acima): escalate_human com code `decision_closed` — fail-closed,
 *   nunca auto sem pending (§4.5); commit nesse estado → 409 decision_closed (rota). Ver T-A7-LEVE-EVIDENCE.md §Ambiguidades.
 */
import type { PulseException } from "../w3/exceptions.js";
import type { AlcadaMode } from "../w3/alcada.js";
import type { DecisionState, EscalateTarget, RunFacts } from "./decision.js";

export const ORCH_SCHEMA = "a7.orch.v1" as const;
export const VERDICTS = ["auto_policy", "escalate_human", "await_inputs"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const OPTIONS = ["rerun_a4_human", "fix_readiness", "open_alcada", "edit_premises", "wait"] as const;
export type OrchOption = (typeof OPTIONS)[number];
export type ProvAgent = "A1" | "A2" | "A3" | "A5" | "A6";
export type ProvSeverity = "info" | "warn" | "block";
export interface Provocation { agent: ProvAgent; code: string; severity: ProvSeverity; detail: Record<string, unknown> & { id?: string | null } }

export type AwaitCode = "no_run" | "run_stale" | "readiness_block" | "readiness_exception";
export type EscalateCode = "requires_finance" | "block_exception" | "run_partial" | "run_reasons" | "already_escalated" | "decision_closed";
export type VerdictCode = AwaitCode | EscalateCode | "clean";

export interface CardFacts { id: string; type: string; status: string; version: number; fields: unknown; createdAt?: string }
export interface OrchFacts {
  scenario: { id: string; version: number; status: string };
  /** último run feasible|partial da VERSÃO CORRENTE (null = não há) */
  run: RunFacts | null;
  /** status do último run da versão corrente em qualquer status (basis.runStatus quando não há run done) */
  latestRunStatus: string | null;
  runStale: boolean;
  readinessState: "ok" | "warn" | "block";
  /** exceptions do snapshot W3 já filtradas ao cenário (+ globais readiness/alcada que bloqueiam) — ver scopeExceptions */
  exceptions: PulseException[];
  requiresFinance: boolean;
  alcadaMode: AlcadaMode;
  impactMi: number | null;
  alcadaMi: number | null;
  decisionState: DecisionState;
  escalatedTo: EscalateTarget | null;
  cards: CardFacts[];
}

/** §4: lista de buildExceptions (snapshot W3) filtrada ao cenário + readiness/alcada globais (scenarioId null) que bloqueiam. */
export function scopeExceptions(all: PulseException[], scenarioId: string): PulseException[] {
  return all.filter((e) => e.scenarioId === scenarioId
    || (e.scenarioId === null && e.severity === "block" && (e.source === "readiness" || e.source === "alcada")));
}

const runWarnBlock = (run: RunFacts | null) =>
  (run?.reasons ?? []).filter((r) => r.severity === "warn" || r.severity === "block");

/** Veredito + código estável da primeira condição que decidiu (vai no `why` do commit: a7.<verdict>.v1:<code>). */
export function decideVerdict(f: OrchFacts): { verdict: Verdict; code: VerdictCode; reasons: VerdictCode[] } {
  const wait: AwaitCode[] = [];
  if (!f.run) wait.push("no_run");
  if (f.run && f.runStale) wait.push("run_stale");
  if (f.readinessState === "block") wait.push("readiness_block");
  if (f.exceptions.some((e) => e.severity === "block" && e.source === "readiness")) wait.push("readiness_exception");
  if (wait.length) return { verdict: "await_inputs", code: wait[0], reasons: wait };

  const esc: EscalateCode[] = [];
  if (f.requiresFinance) esc.push("requires_finance");
  if (f.exceptions.some((e) => e.severity === "block")) esc.push("block_exception");
  if (f.run!.dbStatus === "partial") esc.push("run_partial");
  if (runWarnBlock(f.run).length) esc.push("run_reasons");
  if (f.decisionState === "escalated") esc.push("already_escalated");
  if (esc.length) return { verdict: "escalate_human", code: esc[0], reasons: esc };

  if (f.decisionState === "pending" && f.run!.dbStatus === "feasible") return { verdict: "auto_policy", code: "clean", reasons: ["clean"] };
  // approved (ou run em status inesperado): nunca auto fora de pending (§4.5) → humano (fail-closed)
  return { verdict: "escalate_human", code: "decision_closed", reasons: ["decision_closed"] };
}

const A1_CODES: Record<string, string> = { hist_none: "need_curve", hist_insufficient: "hist_gap", anchor_missing: "anchor_missing" };
const excDetail = (e: PulseException) => ({ id: e.id, source: e.source, severity: e.severity, kind: e.kind });

/** §6: stubs A1–A3/A5/A6 derivados dos fatos (sem chamada a agente). A4 nunca. Dedupe (agent, code, detail.id). */
export function buildProvocations(f: OrchFacts): Provocation[] {
  const out: Provocation[] = [];
  for (const c of f.cards) {
    const fl = (c.fields ?? {}) as Record<string, unknown>;
    if (c.type !== "CurvaDemanda" || fl.schema !== "a1.curva.v1" || typeof fl.gapCode !== "string") continue;
    const code = A1_CODES[fl.gapCode];
    if (code) out.push({ agent: "A1", code, severity: "warn", detail: { id: c.id, cardType: c.type, gapCode: fl.gapCode } });
  }
  for (const e of f.exceptions) {
    if (e.source === "premise_gap" || (e.source === "readiness" && e.kind === "capacidade")) {
      out.push({ agent: "A2", code: "supply_gap", severity: e.severity, detail: excDetail(e) });
    }
    if (e.source === "execution") out.push({ agent: "A3", code: "execution_exception", severity: e.severity, detail: excDetail(e) });
  }
  if (f.alcadaMode === "misconfigured") {
    out.push({ agent: "A5", code: "alcada_misconfigured", severity: "warn", detail: { id: null, mode: f.alcadaMode } });
  }
  if (f.run) {
    for (const [i, r] of runWarnBlock(f.run).entries()) {
      const rr = r as { severity?: string; rank?: number; kind?: string };
      out.push({ agent: "A5", code: "policy_violation", severity: rr.severity === "block" ? "block" : "warn",
        detail: { id: `a4_run:${f.run.id}:${rr.rank ?? i + 1}`, runId: f.run.id, kind: rr.kind ?? null, severity: rr.severity } });
    }
  }
  if (f.requiresFinance) {
    out.push({ agent: "A5", code: "alcada_required", severity: "warn",
      detail: { id: null, impactMi: f.impactMi, alcadaMi: f.alcadaMi, mode: f.alcadaMode } });
  }
  for (const e of f.exceptions) out.push({ agent: "A6", code: "pulse_exception", severity: e.severity, detail: excDetail(e) });

  const seen = new Set<string>();
  return out.filter((p) => {
    const k = `${p.agent}|${p.code}|${p.detail.id ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

const PREMISE_ORDER: Record<string, number> = { Gap: 0, CurvaDemanda: 1, Investimento: 2 };

/** §7: pacote mínimo — premissas (≤10, Gap/CurvaDemanda/Investimento primeiro), violações block|warn (≤20), opções acionáveis. */
export function buildPackage(f: OrchFacts, v: { verdict: Verdict; reasons: VerdictCode[] }, prov: Provocation[]) {
  const premises = [...f.cards]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (PREMISE_ORDER[a.c.type] ?? 9) - (PREMISE_ORDER[b.c.type] ?? 9) || a.i - b.i)
    .slice(0, 10)
    .map(({ c }) => ({ id: c.id, type: c.type, status: c.status, version: c.version }));
  const violations = f.exceptions.filter((e) => e.severity === "block" || e.severity === "warn").slice(0, 20)
    .map((e) => ({ id: e.id, source: e.source, severity: e.severity as "block" | "warn", summary: e.summary }));
  const on = new Set<OrchOption>();
  if (v.verdict === "await_inputs" && (v.reasons.includes("no_run") || v.reasons.includes("run_stale"))) on.add("rerun_a4_human");
  if (v.verdict === "await_inputs" && (v.reasons.includes("readiness_block") || v.reasons.includes("readiness_exception"))) on.add("fix_readiness");
  if (f.requiresFinance) on.add("open_alcada");
  if (f.cards.some((c) => c.status === "gap") || prov.some((p) => p.agent === "A1" || (p.agent === "A2" && p.detail.source === "premise_gap"))) {
    on.add("edit_premises");
  }
  if (f.decisionState === "escalated") on.add("wait");
  return { premises, violations, options: OPTIONS.filter((o) => on.has(o)) };
}

export const whyFor = (verdict: "auto_policy" | "escalate_human", code: VerdictCode) =>
  `${verdict === "auto_policy" ? "a7.auto_policy.v1" : "a7.escalate.v1"}:${code}`.slice(0, 120);

export function orchestrate(f: OrchFacts) {
  const v = decideVerdict(f);
  const provocations = buildProvocations(f);
  return {
    verdict: v.verdict, code: v.code, reasons: v.reasons, provocations,
    package: buildPackage(f, v, provocations),
    basis: {
      hasRun: f.run !== null, runStatus: f.run?.dbStatus ?? f.latestRunStatus, runStale: f.runStale,
      requiresFinance: f.requiresFinance, impactMi: f.impactMi, alcadaMi: f.alcadaMi,
      decisionState: f.decisionState, pulseExceptionsCount: f.exceptions.length,
    },
  };
}
