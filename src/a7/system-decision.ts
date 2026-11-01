/**
 * T-A7-LEVE §5 — decisão gravada pelo próprio A7 (actor.role=system, userId=null). Reusa as pré-condições de run/why de
 * evaluateDecision (decision.ts) e só troca as checagens de papel humano pelas regras do commit do orchestrator:
 *   approved                    → 409 decision_closed
 *   escalated + escalate        → 409 already_escalated (já aguarda humano; §4.4)
 *   escalated + approve         → 409 already_escalated (auto_policy exige pending; defensivo)
 *   approve com requiresFinance → 403 alcada_finance_required (defensivo: §2 proíbe auto-aprovar sob alçada)
 *   pending                     → evaluateDecision(action, why, {…, actorRole: system}) — run done/não stale p/ approve;
 *                                 escalateTo = finance se requiresFinance, senão domain_owner (mesma derivação do POST humano).
 */
import { HttpError } from "../http/errors.js";
import { type ActorRole, type DecisionAction, type DecisionFacts, decisionState, escalatedTo, evaluateDecision } from "./decision.js";

export const SYSTEM_ACTOR: ActorRole = "system";

export function evaluateSystemDecision(action: DecisionAction, why: string, f: Omit<DecisionFacts, "actorRole" | "escalateTo">) {
  const state = decisionState(f.events);
  if (state === "approved") throw new HttpError(409, "decision_closed", { state });
  if (state === "escalated") throw new HttpError(409, "already_escalated", { state, escalateTo: escalatedTo(f.events) });
  if (action === "approve" && f.requiresFinance) {
    throw new HttpError(403, "alcada_finance_required", { hint: "investimento acima da alçada: A7 nunca auto-aprova" });
  }
  return evaluateDecision(action, why, { ...f, actorRole: SYSTEM_ACTOR, escalateTo: null });
}
