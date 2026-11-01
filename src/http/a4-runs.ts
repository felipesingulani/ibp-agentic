/**
 * W1c — API do run A4 (tenant via header + RLS, como /api/a4-readiness). Sem LLM, sem write-back.
 *   POST /api/a4-runs  {scenario_id, weights?, time_limit_ms?} → 202 {data: run(status queued)}
 *        400 invalid_reference (cenário inexistente/de outro tenant/não corrente) · 409 a4_not_ready (prontidão = block)
 *        · 409 {error:{code:"cadastro_gate_block", items}} (AR-07, depois da prontidão, antes do INSERT)
 *   GET  /api/a4-runs?scenario_id=   → lista (mais recente primeiro)
 *   GET  /api/a4-runs/:id            → run: status queued|running|done|failed|discarded, outcome feasible|partial,
 *        summary = A4RunSummary (contracts/a4-run-summary.schema.json), plan, error.
 * T-A4-SOLVER-WORKER: com A4_SOLVER_URL set, preflight GET ${URL}/health (2s) antes do INSERT; falha →
 *        503 {error:{code:"solver_unavailable"}} e nenhum run criado. URL unset → comportamento W1c (spawn local).
 */
import { randomBytes } from "node:crypto";
import express from "express";
import { z } from "zod";
import { type Pool, withTenant } from "../db/pool.js";
import { executeRun } from "../a4/run.js";
import { SOLVER_UNAVAILABLE, remoteSolverHealthy, remoteSolverUrl } from "../a4/solve.js";
import { REASON_KINDS } from "../a4/explain.js";
import { computeReadiness, loadReadinessFacts } from "../domain/a4Readiness.js";
import { gateBlockBody, loadScenarioGates } from "../cadastro/gates.js";
import { type Row, audit, ctxOf, requireUser, uuidRe } from "./common.js";
import { HttpError } from "./errors.js";

const w = z.number().min(0).max(1e9).optional();
const createSchema = z.object({
  scenario_id: z.uuid(),
  weights: z.object({ unmet: w, service: w, contract: w, window: w }).strict().optional(),
  time_limit_ms: z.number().int().min(100).max(20000).optional(),
}).strict();

const apiStatus = (s: string) => (s === "feasible" || s === "partial" ? "done" : s);

export function runOut(r: Row) {
  const counts = Object.fromEntries(REASON_KINDS.map((k) => [k, Number((r.counts_by_kind as Record<string, number>)?.[k] ?? 0)]));
  return {
    id: r.id, run_code: r.run_code, status: apiStatus(r.status as string),
    outcome: r.status === "feasible" || r.status === "partial" ? r.status : null,
    summary: { runId: r.id, scenarioId: r.scenario_id, scenarioVersion: r.scenario_version, reasons: r.reasons ?? [], countsByKind: counts },
    plan: r.plan ?? null, error: r.error ?? null, started_at: r.started_at, finished_at: r.finished_at,
  };
}

export function a4RunsRouter(pool: Pool, opts: { defaultTimeLimitMs?: number } = {}) {
  const r = express.Router();

  r.post("/", async (req, res) => {
    const ctx = ctxOf(res);
    requireUser(ctx);
    const body = createSchema.parse(req.body ?? {});
    const solverUrl = remoteSolverUrl();
    if (solverUrl && !(await remoteSolverHealthy(solverUrl))) {
      res.status(503).json({ error: { code: SOLVER_UNAVAILABLE } }); // shape do contrato §4.3; sem transação aberta, sem INSERT
      return;
    }
    const outcome = await withTenant(pool, ctx.tenantId, async (c) => {
      const sc = (await c.query("SELECT id, version FROM scenarios WHERE id = $1 AND is_current", [body.scenario_id])).rows[0];
      if (!sc) throw new HttpError(400, "invalid_reference", { field: "scenario_id" });
      const readiness = computeReadiness(await loadReadinessFacts(c));
      if (readiness.state === "block") throw new HttpError(409, "a4_not_ready", readiness);
      const gates = await loadScenarioGates(c, String(sc.id));
      if (gates.state === "block") return { blocked: gates.items };
      const code = `RUN-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(2).toString("hex")}`;
      const ins = (await c.query(
        `INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status)
         VALUES ($1, $2, $3, $4, 'queued') RETURNING *`, [ctx.tenantId, code, sc.id, sc.version])).rows[0];
      await audit(c, ctx, "create", "a4_runs", ins.id as string,
        { scenario_id: sc.id, scenario_version: sc.version, weights: body.weights ?? null });
      return { row: ins as Row };
    });
    if ("blocked" in outcome && outcome.blocked) {
      res.status(409).json(gateBlockBody(outcome.blocked)); // shape aninhado (AR-07), como o 503 do solver — não HttpError
      return;
    }
    const row = outcome.row;
    const timeLimitMs = body.time_limit_ms ?? opts.defaultTimeLimitMs ?? 5000;
    setImmediate(() => { void executeRun(pool, ctx.tenantId, row.id as string, { weights: body.weights, timeLimitMs }); });
    res.status(202).json({ data: runOut(row) });
  });

  r.get("/", async (req, res) => {
    const sid = req.query.scenario_id;
    if (sid !== undefined && (typeof sid !== "string" || !uuidRe.test(sid))) throw new HttpError(400, "invalid_input", { field: "scenario_id" });
    const rows = await withTenant(pool, ctxOf(res).tenantId, (c) => c.query(
      `SELECT * FROM a4_runs ${sid ? "WHERE scenario_id = $1" : ""} ORDER BY started_at DESC LIMIT 200`, sid ? [sid] : []).then((q) => q.rows));
    res.json({ data: rows.map(runOut) });
  });

  r.get("/:id", async (req, res) => {
    if (!uuidRe.test(req.params.id)) throw new HttpError(400, "invalid_input", { field: "id" });
    const row = await withTenant(pool, ctxOf(res).tenantId, (c) =>
      c.query("SELECT * FROM a4_runs WHERE id = $1", [req.params.id]).then((q) => q.rows[0]));
    if (!row) throw new HttpError(404, "not_found");
    res.json({ data: runOut(row) });
  });
  return r;
}
