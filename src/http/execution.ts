/**
 * W4 · Task 10 — API de execução (docs/architecture/W4-EXECUTION-PULSE-WRITE-CONTRACT.md). Tenant via header + RLS; sem rede, sem agente.
 *   POST /api/execution/movements            {planRunId, periodStart (dia), kind, qtyActual, qtyPlanned?, nodeId?, skuId?, uom?, note?, scenarioId?}
 *        → 201 {data: ExecutionMovement} · 400 validation_failed|invalid_reference · 409 plan_run_mismatch|run_not_done · 401 sem x-user-id
 *   POST /api/execution/movements:batch      {movements: [...≤100]} → 201 {data: [...], count}; ALL-OR-NOTHING (cravo PO): 1 erro → rollback,
 *        erro traz details.index da linha · mesma tx + advisory lock do tenant
 *   POST /api/execution/movements/:id/void   {why} → 200 {data} (status=void; sem remoção física) · 404 · 409 already_void
 *   GET  /api/execution/movements?planRunId&from&to&kind&status=posted|void|all (default posted) → {data, count}
 */
import express from "express";
import { z } from "zod";
import { type Pool, withTenant } from "../db/pool.js";
import { ctxOf, requireUser, uuidRe } from "./common.js";
import { HttpError } from "./errors.js";
import { MOVEMENT_KINDS } from "../execution/pulse.js";
import {
  approvedRunIds, batchSchema, insertMovement, listMovements, lockExecution, movementOut, movementSchema, voidMovement, voidSchema,
} from "../execution/store.js";

const listQuery = z.object({
  planRunId: z.uuid().optional(), from: z.iso.date().optional(), to: z.iso.date().optional(),
  kind: z.enum(MOVEMENT_KINDS).optional(), status: z.enum(["posted", "void", "all"]).default("posted"),
}).strict();

export function executionRouter(pool: Pool) {
  const r = express.Router();
  const withApproved = async (c: Parameters<typeof approvedRunIds>[0], rows: Record<string, unknown>[]) => {
    const ok = await approvedRunIds(c, [...new Set(rows.map((x) => String(x.plan_run_id)))]);
    return rows.map((x) => movementOut(x, ok));
  };

  r.post("/movements\\:batch", async (req, res) => {
    const ctx = ctxOf(res); requireUser(ctx);
    const body = batchSchema.parse(req.body ?? {});
    const data = await withTenant(pool, ctx.tenantId, async (c) => {
      await lockExecution(c, ctx.tenantId);
      const rows = [];
      for (const [i, m] of body.movements.entries()) rows.push(await insertMovement(c, ctx, m, "api", i));
      return withApproved(c, rows);
    });
    res.status(201).json({ data, count: data.length });
  });

  r.post("/movements", async (req, res) => {
    const ctx = ctxOf(res); requireUser(ctx);
    const m = movementSchema.parse(req.body ?? {});
    const [data] = await withTenant(pool, ctx.tenantId, async (c) => {
      await lockExecution(c, ctx.tenantId);
      return withApproved(c, [await insertMovement(c, ctx, m, "api")]);
    });
    res.status(201).json({ data });
  });

  r.post("/movements/:id/void", async (req, res) => {
    const ctx = ctxOf(res); requireUser(ctx);
    if (!uuidRe.test(req.params.id)) throw new HttpError(400, "invalid_input", { field: "id" });
    const { why } = voidSchema.parse(req.body ?? {});
    const [data] = await withTenant(pool, ctx.tenantId, async (c) => {
      await lockExecution(c, ctx.tenantId);
      return withApproved(c, [await voidMovement(c, ctx, req.params.id, why)]);
    });
    res.json({ data });
  });

  r.get("/movements", async (req, res) => {
    const f = listQuery.parse(req.query);
    if (f.from && f.to && f.from > f.to) throw new HttpError(400, "invalid_input", { field: "from", hint: "from ≤ to" });
    const data = await withTenant(pool, ctxOf(res).tenantId, async (c) => withApproved(c, await listMovements(c, f)));
    res.json({ data, count: data.length });
  });
  return r;
}
