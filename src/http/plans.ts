/**
 * W7 · Task 13 — export do plano aprovado (docs/architecture/W7-PLAN-EXPORT-CONTRACT.md). Só GET; tenant header + RLS.
 *   GET /api/plans/approved/export?format=json|csv → 200 attachment (Content-Disposition, Cache-Control: no-store; CSV com BOM UTF-8)
 *   Ordem: sem x-user-id 401 · papel ∉ admin|domain_owner|finance 403 forbidden_role {required} · format inválido 400 validation_failed {field}
 *          · basis ≠ approved 409 no_approved_plan {basis} · OK 200 + 1 linha audit_log (action=export) na mesma tx do SELECT.
 *   Sem rede, sem ERP, sem arquivo em disco; 4xx não grava audit.
 */
import express from "express";
import { type Pool, withTenant } from "../db/pool.js";
import { audit, ctxOf } from "./common.js";
import { HttpError } from "./errors.js";
import { EXPORT_ROLES, assertPlanExport, isExportRole, parseExportFormat } from "../plans/contract.js";
import { exportFilename, loadApprovedExport, toCsv } from "../plans/export.js";

const BOM = "\uFEFF";

export function plansRouter(pool: Pool) {
  const r = express.Router();
  // HEAD/non-GET → 405 antes do handler (Express 5 roteia HEAD pro GET): sem corpo entregue ⇒ sem audit.
  r.all("/approved/export", (req, res, next) => {
    if (req.method === "GET") return next();
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "method_not_allowed" });
  });
  r.get("/approved/export", async (req, res) => {
    const ctx = ctxOf(res);
    if (!ctx.userId) throw new HttpError(401, "x-user-id required");
    if (!isExportRole(ctx.role)) throw new HttpError(403, "forbidden_role", { required: [...EXPORT_ROLES] }); // antes de qualquer leitura
    const format = parseExportFormat(req.query.format);
    const out = await withTenant(pool, ctx.tenantId, async (c) => {
      const p = await loadApprovedExport(c, new Date().toISOString());
      if (format === "json") assertPlanExport(p); // fora do contrato → 500 + rollback (sem audit)
      await audit(c, ctx, "export", "a4_runs", String(p.planRef.runId), { format, planRef: p.planRef });
      return p;
    });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="${exportFilename(out, format)}"`);
    const body = Buffer.from(format === "json" ? JSON.stringify(out, null, 2) : BOM + toCsv(out), "utf8");
    res.setHeader("Content-Type", format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8");
    res.setHeader("Content-Length", String(body.length));
    res.status(200).end(body); // end (não send): sem ETag/304 — todo 200 auditado entrega o arquivo inteiro
  });
  return r;
}
