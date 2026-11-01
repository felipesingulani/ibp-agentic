import type { Client } from "../db/pool.js";

/** Última mudança de premissa do cenário (criação ou PATCH auditado) — base do "stale" do run. */
export async function lastPremiseChangeAt(c: Client, scenarioId: string): Promise<Date | null> {
  const r = await c.query(
    `SELECT GREATEST(
        (SELECT max(created_at) FROM premise_cards WHERE scenario_id = $1),
        (SELECT max(a.at) FROM audit_log a WHERE a.entity = 'premise_cards'
           AND a.entity_id IN (SELECT id::text FROM premise_cards WHERE scenario_id = $1))) AS t`, [scenarioId]);
  return r.rows[0].t ? new Date(r.rows[0].t) : null;
}
