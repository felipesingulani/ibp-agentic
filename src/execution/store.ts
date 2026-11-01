/**
 * W4 · Task 10 — escrita/leitura de execution_movements (sob RLS, conexão ibp_app). Append-only: INSERT + void (status).
 * Âncora (regra 2): run tem de existir no tenant e estar done (feasible|partial); run sem approve (A7) → aceito + tag unapproved_plan.
 * scenario_id/scenario_version vêm SEMPRE do run (nunca do body); body.scenarioId (opcional) ≠ run → 409 plan_run_mismatch.
 */
import { z } from "zod";
import type { Client } from "../db/pool.js";
import { type Ctx, type Row, assertCurrentRefs, audit } from "../http/common.js";
import { HttpError } from "../http/errors.js";
import { assertExecutionMovement } from "./contract.js";
import { MOVEMENT_KINDS, type MovementFact } from "./pulse.js";

export const BATCH_MAX = 100;
export const movementSchema = z.object({
  planRunId: z.uuid(),
  scenarioId: z.uuid().optional(),
  periodStart: z.iso.date(),
  kind: z.enum(MOVEMENT_KINDS),
  qtyActual: z.number().min(0),
  qtyPlanned: z.number().min(0).nullable().optional(),
  nodeId: z.uuid().nullable().optional(),
  skuId: z.uuid().nullable().optional(),
  uom: z.string().trim().min(1).max(32).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
}).strict();
export type MovementIn = z.infer<typeof movementSchema>;
export const batchSchema = z.object({ movements: z.array(movementSchema).min(1).max(BATCH_MAX) }).strict();
export const voidSchema = z.object({ why: z.string().trim().min(1, "why é obrigatório no void").max(2000) }).strict();

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
// node-pg: coluna date → Date à meia-noite LOCAL → formata por componentes locais (não UTC) p/ não deslocar o dia
const pad = (n: number) => String(n).padStart(2, "0");
const day = (v: unknown) => (v instanceof Date ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : String(v).slice(0, 10));

export async function approvedRunIds(c: Client, runIds: string[]): Promise<Set<string>> {
  if (!runIds.length) return new Set();
  const r = await c.query(
    `SELECT DISTINCT d.run_id FROM decision_events d JOIN a4_runs r ON r.id = d.run_id
      WHERE d.action = 'approve' AND d.run_id = ANY($1::uuid[]) AND d.scenario_version = r.scenario_version`, [runIds]);
  return new Set(r.rows.map((x) => String(x.run_id)));
}

export function movementOut(r: Row, approved: Set<string>) {
  const out = {
    id: String(r.id), planRunId: String(r.plan_run_id), scenarioId: String(r.scenario_id), scenarioVersion: Number(r.scenario_version),
    periodStart: day(r.period_start), kind: String(r.kind), nodeId: (r.node_id as string | null) ?? null, skuId: (r.sku_id as string | null) ?? null,
    qtyPlanned: num(r.qty_planned), qtyActual: Number(r.qty_actual), uom: (r.uom as string | null) ?? null, status: String(r.status),
    source: String(r.source), note: (r.note as string | null) ?? null, at: new Date(r.at as string).toISOString(),
    actorUserId: (r.actor_user_id as string | null) ?? null, actorRole: (r.actor_role as string | null) ?? null,
    tags: approved.has(String(r.plan_run_id)) ? [] : ["unapproved_plan"],
  };
  assertExecutionMovement(out);
  return out;
}

export const lockExecution = (c: Client, tenantId: string) =>
  c.query("SELECT pg_advisory_xact_lock(hashtextextended('execution:' || $1, 0))", [tenantId]);

/** Insere 1 movimento (dentro da tx do chamador). `at` = índice no batch p/ erro apontar a linha. */
export async function insertMovement(c: Client, ctx: Ctx, m: MovementIn, source: "api" | "seed", at: number | null = null) {
  const where = at === null ? {} : { index: at };
  const run = (await c.query("SELECT id, scenario_id, scenario_version, status FROM a4_runs WHERE id = $1", [m.planRunId])).rows[0];
  if (!run) throw new HttpError(400, "invalid_reference", { field: "planRunId", ...where });
  if (m.scenarioId && m.scenarioId !== run.scenario_id)
    throw new HttpError(409, "plan_run_mismatch", { field: "scenarioId", runScenarioId: run.scenario_id, ...where });
  if (!["feasible", "partial"].includes(String(run.status)))
    throw new HttpError(409, "run_not_done", { field: "planRunId", status: run.status, ...where });
  try {
    if (m.nodeId) await assertCurrentRefs(c, "nodes", "nodeId", [m.nodeId]);
    if (m.skuId) await assertCurrentRefs(c, "skus", "skuId", [m.skuId]);
  } catch (e) {
    if (e instanceof HttpError) throw new HttpError(e.status, e.message, { ...(e.details as object), ...where });
    throw e;
  }
  const uom = m.uom ?? (await c.query("SELECT uom FROM tenant_settings")).rows[0]?.uom ?? null;
  const row = (await c.query(
    `INSERT INTO execution_movements (tenant_id, plan_run_id, scenario_id, scenario_version, period_start, kind, node_id, sku_id,
       qty_planned, qty_actual, uom, source, note, actor_user_id, actor_role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [ctx.tenantId, run.id, run.scenario_id, run.scenario_version, m.periodStart, m.kind, m.nodeId ?? null, m.skuId ?? null,
      m.qtyPlanned ?? null, m.qtyActual, uom, source, m.note ?? null, ctx.userId, ctx.role])).rows[0];
  await audit(c, ctx, "create", "execution_movements", String(row.id), {
    planRunId: run.id, scenarioId: run.scenario_id, scenarioVersion: run.scenario_version, periodStart: m.periodStart, kind: m.kind,
    qtyPlanned: m.qtyPlanned ?? null, qtyActual: m.qtyActual, nodeId: m.nodeId ?? null, skuId: m.skuId ?? null, source, ...(at === null ? {} : { batchIndex: at }),
  });
  return row;
}

export async function voidMovement(c: Client, ctx: Ctx, id: string, why: string) {
  const cur = (await c.query("SELECT * FROM execution_movements WHERE id = $1", [id])).rows[0];
  if (!cur) throw new HttpError(404, "not_found");
  if (cur.status === "void") throw new HttpError(409, "already_void");
  const row = (await c.query("UPDATE execution_movements SET status = 'void' WHERE id = $1 RETURNING *", [id])).rows[0];
  await audit(c, ctx, "void", "execution_movements", id, { why, planRunId: cur.plan_run_id, periodStart: day(cur.period_start), kind: cur.kind });
  return row;
}

export interface ListFilter { planRunId?: string; from?: string; to?: string; kind?: string; status: "posted" | "void" | "all" }
export async function listMovements(c: Client, f: ListFilter) {
  const where: string[] = [], p: unknown[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace("?", `$${p.length}`)); };
  if (f.status !== "all") add("status = ?", f.status);
  if (f.planRunId) add("plan_run_id = ?", f.planRunId);
  if (f.from) add("period_start >= ?::date", f.from);
  if (f.to) add("period_start <= ?::date", f.to);
  if (f.kind) add("kind = ?", f.kind);
  return (await c.query(
    `SELECT * FROM execution_movements ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY period_start, at, id LIMIT 1000`, p)).rows;
}

/** Leitura p/ o Pulse (W3 snapshot): movimentos posted do run do planRef. */
export async function loadPlanMovements(c: Client, runId: string): Promise<MovementFact[]> {
  const rows = (await c.query(
    `SELECT period_start, kind, node_id, sku_id, qty_planned, qty_actual FROM execution_movements
      WHERE plan_run_id = $1 AND status = 'posted' ORDER BY period_start, id`, [runId])).rows;
  return rows.map((r) => ({ periodStart: day(r.period_start), kind: r.kind, nodeId: r.node_id ?? null, skuId: r.sku_id ?? null,
    qtyPlanned: num(r.qty_planned), qtyActual: Number(r.qty_actual) }));
}
