/**
 * W3 · planRef — qual plano os números de Pulse e Visões descrevem (resolvido 1× por request; mesma verdade p/ toda lente).
 *   approved   → último approve cujo run é feasible|partial da MESMA scenario_version, e essa versão ainda é a corrente
 *                (cenário corrente, não arquivado). Aprovação de versão superada não vira plano vigente.
 *   latest_run → senão, último run feasible|partial de cenário corrente não arquivado (UI: tag "não aprovado").
 *   none       → nenhum run done → KPIs null (no_plan).
 */
import type { Client } from "../db/pool.js";
import type { Row } from "../http/common.js";

export type PlanBasis = "approved" | "latest_run" | "none";
export interface PlanRef { basis: PlanBasis; scenarioId: string | null; scenarioVersion: number | null; runId: string | null; at: string | null }

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export async function resolvePlanRef(c: Client): Promise<{ planRef: PlanRef; run: Row | null }> {
  const appr = (await c.query(
    `SELECT d.at AS decided_at, r.* FROM decision_events d
       JOIN a4_runs r ON r.id = d.run_id
       JOIN scenarios s ON s.id = d.scenario_id
      WHERE d.action = 'approve' AND r.status IN ('feasible','partial') AND r.scenario_id = d.scenario_id
        AND r.scenario_version = d.scenario_version AND d.scenario_version = s.version
        AND s.is_current AND s.status <> 'archived'
      ORDER BY d.at DESC, d.id DESC LIMIT 1`)).rows[0];
  if (appr) {
    return { run: appr, planRef: { basis: "approved", scenarioId: String(appr.scenario_id),
      scenarioVersion: Number(appr.scenario_version), runId: String(appr.id), at: iso(appr.decided_at) } };
  }
  const last = (await c.query(
    `SELECT r.* FROM a4_runs r JOIN scenarios s ON s.id = r.scenario_id
      WHERE r.status IN ('feasible','partial') AND s.is_current AND s.status <> 'archived'
      ORDER BY coalesce(r.finished_at, r.started_at) DESC, r.started_at DESC, r.id DESC LIMIT 1`)).rows[0];
  if (last) {
    return { run: last, planRef: { basis: "latest_run", scenarioId: String(last.scenario_id),
      scenarioVersion: Number(last.scenario_version), runId: String(last.id), at: iso(last.finished_at ?? last.started_at) } };
  }
  return { run: null, planRef: { basis: "none", scenarioId: null, scenarioVersion: null, runId: null, at: null } };
}
