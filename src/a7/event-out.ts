/**
 * DecisionEvent de saída (contracts/decision-event.schema.json v0.2). Campos v0.2 opcionais (impactMi, alcadaMi, escalateTo)
 * ficam no payload jsonb do audit_log da própria decisão (append-only, gravado na mesma transação do INSERT) — sem coluna nova.
 * Evento V0 (antes da Task 8) não tem esses campos no payload → saem omitidos (V0 continua válido no schema v0.2).
 */
import type { Row } from "../http/common.js";
import type { ActorRole, DecisionAction } from "./decision.js";

export type EscalateTo = "finance" | "domain_owner";
export interface DecisionOut {
  id: string; scenarioId: string; scenarioVersion: number; runId: string | null; action: DecisionAction; why: string;
  actor: { role: ActorRole; userId: string | null }; at: string; exportRef: string | null;
  impactMi?: number | null; alcadaMi?: number | null; escalateTo?: EscalateTo | null;
}

/** SELECT de decision_events + payload do audit_log da decisão (alias `ap`). Rodar sob RLS. */
export const DECISION_SELECT = `SELECT d.*, a.payload AS ap FROM decision_events d
  LEFT JOIN LATERAL (SELECT payload FROM audit_log al WHERE al.entity = 'decision_events' AND al.entity_id = d.id::text
                      ORDER BY al.id LIMIT 1) a ON true`;

const V02 = ["impactMi", "alcadaMi", "escalateTo"] as const;

export function decisionOut(r: Row): DecisionOut {
  const out: DecisionOut = {
    id: String(r.id), scenarioId: String(r.scenario_id), scenarioVersion: Number(r.scenario_version),
    runId: r.run_id ? String(r.run_id) : null, action: r.action as DecisionAction, why: String(r.why),
    actor: { role: String(r.actor_role) as ActorRole, userId: r.actor_user_id ? String(r.actor_user_id) : null },
    at: new Date(r.at as string).toISOString(), exportRef: (r.export_ref as string | null) ?? null,
  };
  const ap = (r.ap ?? null) as Record<string, unknown> | null;
  if (ap) for (const k of V02) if (k in ap) (out as unknown as Record<string, unknown>)[k] = ap[k] ?? null;
  return out;
}
