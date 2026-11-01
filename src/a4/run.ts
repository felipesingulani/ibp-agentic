/**
 * W1c — ciclo de vida do run A4: queued → running → feasible|partial (API: done) | failed.
 * Fila em processo (setImmediate), um filho CBC por run. Snapshot lido sob RLS (withTenant) — o filho
 * não acessa banco. Resultado persistido em a4_runs (reasons ≤3, counts_by_kind, plan). Sem write-back.
 */
import type pg from "pg";
import { type Client, withTenant } from "../db/pool.js";
import { buildModel, checkPilotLimits, paramsFrom, type Snapshot, type Weights } from "./model.js";
import { explain } from "./explain.js";
import { solve } from "./solve.js";
import { effectivePolicyKinds } from "../domain/policy-kinds.js";

export interface RunOptions { weights?: Partial<Weights>; timeLimitMs: number }

const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function loadSnapshot(c: Client, scenario: Snapshot["scenario"]): Promise<Snapshot> {
  const nodes = (await c.query("SELECT stable_id AS id, code FROM nodes WHERE is_current ORDER BY code")).rows;
  const cap = (await c.query(`SELECT nc.node_id, sum(nc.capacity_t_month)::float8 AS cap FROM node_capacity nc
      JOIN nodes n ON n.tenant_id = nc.tenant_id AND n.stable_id = nc.node_id AND n.is_current
     WHERE nc.is_current AND nc.capacity_t_month > 0 GROUP BY nc.node_id`)).rows;
  const routes = (await c.query(`SELECT r.stable_id AS id, r.code, r.origin_node_id AS origin, r.dest_node_id AS dest,
         r.cost_per_ton::float8 AS cost, r.lead_time_days::float8 AS "leadTimeDays"
      FROM routes r
      JOIN nodes o ON o.tenant_id = r.tenant_id AND o.stable_id = r.origin_node_id AND o.is_current
      JOIN nodes d ON d.tenant_id = r.tenant_id AND d.stable_id = r.dest_node_id AND d.is_current
     WHERE r.is_current ORDER BY r.code`)).rows;
  const skus = (await c.query("SELECT stable_id AS id, code FROM skus WHERE is_current ORDER BY code")).rows;
  const period = (await c.query("SELECT max(period) AS p FROM sales_history")).rows[0].p as string | null;
  const demand = period ? (await c.query(`SELECT h.node_id AS node, h.sku_id AS sku, sum(h.qty)::float8 AS qty FROM sales_history h
      JOIN nodes n ON n.tenant_id = h.tenant_id AND n.stable_id = h.node_id AND n.is_current
      JOIN skus s ON s.tenant_id = h.tenant_id AND s.stable_id = h.sku_id AND s.is_current
     WHERE h.period = $1 GROUP BY h.node_id, h.sku_id ORDER BY 1, 2`, [period])).rows : [];
  const policies = (await c.query("SELECT stable_id AS id, kind, body FROM policies WHERE is_current")).rows;
  const ts = (await c.query("SELECT supply_external_in_scope AS f, policy_kinds FROM tenant_settings")).rows[0];
  const ext = ts?.f === true;
  const policyKinds = effectivePolicyKinds(ts?.policy_kinds ?? {}); // F-1: mesmo vocabulário da prontidão ({}/sem linha → legado)
  const contracts = ext ? (await c.query("SELECT stable_id AS id, code, sku_ids, obligations FROM supplier_contracts WHERE is_current ORDER BY code"))
    .rows.map((r) => ({ id: r.id, code: r.code, skuIds: r.sku_ids as string[],
      minVolume: numOrNull(r.obligations?.min_volume), maxVolume: numOrNull(r.obligations?.max_volume) })) : [];
  const gapCards = (await c.query(`SELECT id, card_id, node_id, fields FROM premise_cards
      WHERE scenario_id = $1 AND type = 'Gap' AND status = 'gap' ORDER BY card_id`, [scenario.id]))
    .rows.map((r) => ({ id: r.id, cardId: r.card_id, nodeId: r.node_id, fields: r.fields ?? {} }));
  return { scenario, period, nodes, capacity: Object.fromEntries(cap.map((r) => [r.node_id, r.cap])), routes, skus,
    demand, policies, contracts, gapCards, policyKinds };
}

/** Executa um run já criado (status queued). Nunca lança: falha vira status failed + error. */
export async function executeRun(pool: pg.Pool, tenantId: string, runId: string, opts: RunOptions): Promise<void> {
  try {
    const snap = await withTenant(pool, tenantId, async (c) => {
      const run = (await c.query(
        `UPDATE a4_runs SET status = 'running' WHERE id = $1 AND status = 'queued'
         RETURNING scenario_id, scenario_version`, [runId])).rows[0];
      if (!run) return null;
      const sc = (await c.query("SELECT code FROM scenarios WHERE id = $1", [run.scenario_id])).rows[0];
      return loadSnapshot(c, { id: run.scenario_id, version: run.scenario_version, code: sc?.code ?? "" });
    });
    if (!snap) return;
    const limit = checkPilotLimits(snap);
    if (limit) throw new Error(limit);
    const params = paramsFrom(snap, opts.weights);
    const result = await solve(buildModel(snap, params, opts.timeLimitMs));
    if (result.status !== "optimal" && result.status !== "feasible") throw new Error(`solver: ${result.status}`);
    const out = explain(snap, params, result);
    const status = out.plan.totals.unmet > 1e-6 ? "partial" : "feasible";
    await withTenant(pool, tenantId, (c) => c.query(
      `UPDATE a4_runs SET status = $2, reasons = $3::jsonb, counts_by_kind = $4::jsonb, plan = $5::jsonb, finished_at = now()
        WHERE id = $1`,
      [runId, status, JSON.stringify(out.reasons), JSON.stringify(out.countsByKind),
        JSON.stringify({ ...out.plan, params: { ...params }, reasonCandidates: out.candidates })]));
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 300) || "erro";
    await withTenant(pool, tenantId, (c) => c.query(
      "UPDATE a4_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [runId, msg])).catch(() => {});
  }
}
