/**
 * W2b · Task 7 — A7 stub: máquina de estados mínima da decisão (contracts/decision-event.schema.json).
 * Determinística, sem texto gerado por modelo: o A7 aqui só valida transição + regra do porquê; quem escreve o porquê é o humano.
 *
 * Estado por (cenário, scenarioVersion corrente) = última decisão dessa versão:
 *   pending ──approve──▶ approved (terminal da versão)
 *   pending ──escalate─▶ escalated ──approve (só domain_owner)──▶ approved
 *   escalated ──escalate─▶ 409 already_escalated · approved ──*──▶ 409 decision_closed
 * Nova scenarioVersion (cenário editado) volta para pending.
 *
 * Task 8 (alçada Finance, wire B — W3-PULSE-VISOES-API-CONTRACT §Regras 5): `requiresFinance` vem de src/w3/alcada.ts
 * (mesma regra da fila). Cada escalate tem destino `escalateTo` (DecisionEvent v0.2):
 *   pending  + requiresFinance: approve só finance (403 alcada_finance_required); escalate de outro papel → finance;
 *            escalate de finance → domain_owner.
 *   pending  sem alçada: comportamento Task 7 (escalate → domain_owner).
 *   escalated→finance: só finance age (403 escalated_to_finance) — approve fecha; escalate → domain_owner.
 *   escalated→domain_owner (ou evento V0 sem destino): Task 7 — só domain_owner aprova; escalate → 409 already_escalated.
 *   `escalate_to` no body é opcional; se vier, tem de ser igual ao destino derivado (400 invalid_escalate_to).
 *
 * Pré-condições:
 *   approve  → run obrigatório, do mesmo cenário, done (feasible|partial) e NÃO stale
 *              (stale = run.scenarioVersion ≠ versão corrente, cenário status=stale, ou premissa alterada depois do início do run).
 *   escalate → run opcional; se vier, tem de estar terminado (não queued/running). Stale/failed pode escalar (wire v0.3).
 *   cenário archived → 409 nas duas ações.
 * Porquê (why, trim): sempre obrigatório (contrato minLength 1 + CHECK no banco);
 *   ≥ WHY_MIN_STRICT (20) quando o run tem razão warn|block ou outcome partial.
 */
import { HttpError } from "../http/errors.js";

export const DECISION_ACTIONS = ["approve", "escalate"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];
export type DecisionState = "pending" | "approved" | "escalated";
/** actor.role do contrato. users.role 'admin' (seed/W0) não existe no contrato → mapeia p/ domain_owner (ver README). */
export const ACTOR_ROLES = ["domain_owner", "sales", "supply", "finance", "system"] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];
export const WHY_MIN_STRICT = 20;

export interface RunFacts {
  id: string; scenarioId: string; scenarioVersion: number;
  dbStatus: string; // queued|running|feasible|partial|failed|discarded
  reasons: { severity?: string }[]; startedAt: Date;
}
export interface DecisionFacts {
  scenario: { id: string; version: number; status: string };
  run: RunFacts | null;
  lastPremiseChangeAt: Date | null;
  /** eventos da versão corrente, em ordem cronológica (escalateTo ausente = evento V0 → domain_owner) */
  events: { action: DecisionAction; escalateTo?: EscalateTarget | null }[];
  actorRole: ActorRole;
  /** versão corrente exige decisão Finance (alçada); ausente = false */
  requiresFinance?: boolean;
  /** destino pedido no body (opcional) */
  escalateTo?: EscalateTarget | null;
}
export type EscalateTarget = "finance" | "domain_owner";

export const actorRoleOf = (userRole: string | null): ActorRole => {
  if (userRole === "admin") return "domain_owner";
  if ((ACTOR_ROLES as readonly string[]).includes(userRole ?? "") && userRole !== "system") return userRole as ActorRole;
  throw new HttpError(403, "decision_forbidden", { hint: "papel do usuário não decide", role: userRole });
};

export function decisionState(events: { action: DecisionAction }[]): DecisionState {
  const last = events[events.length - 1];
  return !last ? "pending" : last.action === "approve" ? "approved" : "escalated";
}

export function runIsStale(f: Pick<DecisionFacts, "scenario" | "run" | "lastPremiseChangeAt">): boolean {
  if (!f.run) return false;
  return f.run.scenarioVersion !== f.scenario.version || f.scenario.status === "stale"
    || (f.lastPremiseChangeAt !== null && f.lastPremiseChangeAt > f.run.startedAt);
}

export function whyMinFor(run: RunFacts | null): { min: number; because: string | null } {
  if (run && run.dbStatus === "partial") return { min: WHY_MIN_STRICT, because: "run_partial" };
  if (run && run.reasons.some((r) => r.severity === "warn" || r.severity === "block")) {
    return { min: WHY_MIN_STRICT, because: "warn_or_block_reasons" };
  }
  return { min: 1, because: null };
}

/** Valida a transição; devolve o próximo estado ou lança HttpError (status/código estáveis p/ a UI). */
/** Destino atual de uma versão escalada (evento V0 sem destino = domain_owner, regra Task 7). */
export const escalatedTo = (events: DecisionFacts["events"]): EscalateTarget | null => {
  const last = events[events.length - 1];
  return last?.action === "escalate" ? (last.escalateTo ?? "domain_owner") : null;
};

export function evaluateDecision(action: DecisionAction, why: string, f: DecisionFacts):
  { next: DecisionState; whyMin: number; escalateTo: EscalateTarget | null } {
  const w = why.trim();
  if (f.scenario.status === "archived") throw new HttpError(409, "scenario_archived");
  const state = decisionState(f.events);
  if (state === "approved") throw new HttpError(409, "decision_closed", { state });
  const target = escalatedTo(f.events);
  if (state === "escalated" && target === "finance") {
    if (f.actorRole !== "finance") throw new HttpError(403, "escalated_to_finance", { state, role: f.actorRole });
  } else if (state === "escalated") {
    if (action === "escalate") throw new HttpError(409, "already_escalated", { state });
    if (f.actorRole !== "domain_owner") throw new HttpError(403, "escalated_to_domain_owner", { state, role: f.actorRole });
  } else if (action === "approve" && f.requiresFinance && f.actorRole !== "finance") {
    throw new HttpError(403, "alcada_finance_required", { role: f.actorRole, hint: "investimento acima da alçada: decisão da Finance" });
  }
  let escalateTo: EscalateTarget | null = null;
  if (action === "escalate") {
    escalateTo = f.actorRole === "finance" || state === "escalated" || !f.requiresFinance ? "domain_owner" : "finance";
    if (f.escalateTo && f.escalateTo !== escalateTo) {
      throw new HttpError(400, "invalid_escalate_to", { field: "escalate_to", expected: escalateTo });
    }
  }
  const run = f.run;
  if (run && run.scenarioId !== f.scenario.id) throw new HttpError(400, "invalid_reference", { field: "run_id" });
  if (action === "approve") {
    if (!run) throw new HttpError(400, "run_required", { field: "run_id", hint: "aprovar exige um run A4 concluído" });
    if (run.dbStatus !== "feasible" && run.dbStatus !== "partial") {
      throw new HttpError(409, "run_not_done", { run_status: run.dbStatus });
    }
    if (runIsStale(f)) {
      throw new HttpError(409, "run_stale", {
        run_scenario_version: run.scenarioVersion, scenario_version: f.scenario.version,
        hint: "re-rode o A4 antes de aprovar; escalar continua possível",
      });
    }
  } else if (run && (run.dbStatus === "queued" || run.dbStatus === "running")) {
    throw new HttpError(409, "run_not_finished", { run_status: run.dbStatus });
  }
  const { min, because } = whyMinFor(run);
  if (w.length < min) {
    throw new HttpError(400, w.length ? "why_too_short" : "why_required", { field: "why", min, because });
  }
  return { next: action === "approve" ? "approved" : "escalated", whyMin: min, escalateTo };
}
