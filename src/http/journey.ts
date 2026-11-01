/**
 * W5 · Task 11 — Journey D3 API (docs/architecture/W5-JOURNEY-D3-CONTRACT.md). Tenant LAB via header + RLS; sem rede, sem agente.
 *   POST /api/journey/runs                    {code?: "JR-…", scope?: {bu?, nodeStableIds?, skuFamilies?}, sponsorRole?} → 201 · 409 journey_code_exists
 *   GET  /api/journey/runs?status=            → {data: Run[], count}
 *   GET  /api/journey/runs/:id                → {data: Run} · 404 journey_not_found
 *   POST /api/journey/runs/:id/snapshot       → {data: Run} (snapshot leverage/consensus/roles; só em open)
 *   POST /api/journey/runs/:id/steps/:stepId/complete {notes?} → stepId ∈ leverage|consensus|roles|conviction
 *        409 snapshot_required | step_already_done | conviction_not_generated | journey_invalid_status · 400 invalid_step
 *        409 steps_out_of_order {stepId, requires, missing} (W6: ordem forçada leverage → consensus → roles → conviction)
 *   POST /api/journey/runs/:id/conviction     → {data: Run} (status=conviction + conviction_ref; JSON+MD em disco) · 409 steps_incomplete
 *   GET  /api/journey/runs/:id/conviction?format=json|md → download (attachment); sem format → {data: {ref, pack, markdown}}
 *        404 conviction_not_generated | conviction_file_missing
 *   POST /api/journey/runs/:id/land           {landTenantId?} | {slug?, name?} → {data: {run, land}}; omitido → cria tenant thin + pack default
 *        409 land_code_exists (slug colide) | steps_incomplete | journey_invalid_status · 400 invalid_reference (landTenantId)
 *        W6: 403 forbidden_role {required} se papel ∉ admin|domain_owner (thin e link, antes de qualquer leitura);
 *        link só se o mesmo e-mail do ator é admin no alvo (0017) — senão 400 invalid_reference uniforme (sem oráculo).
 */
import express from "express";
import { type Pool, withTenant } from "../db/pool.js";
import { ctxOf, requireUser, uuidRe } from "./common.js";
import { HttpError } from "./errors.js";
import { LAND_ROLES, createSchema, downloadQuery, landSchema, listQuery, stepSchema } from "../journey/contract.js";
import { completeStep, createRun, generateConviction, getRun, landRun, landWarn, listRuns, runOut, snapshotRun } from "../journey/store.js";
import { readPackFile } from "../journey/conviction.js";

const idOf = (v: string) => { if (!uuidRe.test(v)) throw new HttpError(400, "invalid_input", { field: "id" }); return v; };

export function journeyRouter(pool: Pool) {
  const r = express.Router();

  r.post("/runs", async (req, res) => {
    const ctx = ctxOf(res); requireUser(ctx);
    const b = createSchema.parse(req.body ?? {});
    const row = await withTenant(pool, ctx.tenantId, (c) => createRun(c, ctx, b));
    res.status(201).json({ data: runOut(row) });
  });

  r.get("/runs", async (req, res) => {
    const q = listQuery.parse(req.query);
    const rows = await withTenant(pool, ctxOf(res).tenantId, (c) => listRuns(c, q.status));
    res.json({ data: rows.map(runOut), count: rows.length });
  });

  r.get("/runs/:id", async (req, res) => {
    const id = idOf(req.params.id);
    res.json({ data: runOut(await withTenant(pool, ctxOf(res).tenantId, (c) => getRun(c, id))) });
  });

  r.post("/runs/:id/snapshot", async (req, res) => {
    const ctx = ctxOf(res); requireUser(ctx);
    const id = idOf(req.params.id);
    res.json({ data: runOut(await withTenant(pool, ctx.tenantId, (c) => snapshotRun(c, ctx, id))) });
  });

  r.post("/runs/:id/steps/:stepId/complete", async (req, res) => {
    const ctx = ctxOf(res); requireUser(ctx);
    const id = idOf(req.params.id);
    const b = stepSchema.parse(req.body ?? {});
    res.json({ data: runOut(await withTenant(pool, ctx.tenantId, (c) => completeStep(c, ctx, id, req.params.stepId, b.notes ?? null))) });
  });

  r.post("/runs/:id/conviction", async (req, res) => {
    const ctx = ctxOf(res); requireUser(ctx);
    const id = idOf(req.params.id);
    res.json({ data: runOut(await withTenant(pool, ctx.tenantId, (c) => generateConviction(c, ctx, id))) });
  });

  r.get("/runs/:id/conviction", async (req, res) => {
    const id = idOf(req.params.id);
    const q = downloadQuery.parse(req.query);
    const row = await withTenant(pool, ctxOf(res).tenantId, (c) => getRun(c, id));
    const ref = row.conviction_ref as string | null;
    if (!ref) throw new HttpError(404, "conviction_not_generated", { hint: `POST /api/journey/runs/${id}/conviction` });
    const [json, md] = await Promise.all([readPackFile(ref, "json"), readPackFile(ref, "md")]);
    if (json === null || md === null) throw new HttpError(404, "conviction_file_missing", { ref });
    const file = `${row.code}-conviction`;
    if (q.format === "json") {
      res.type("application/json").attachment(`${file}.json`).send(json);
    } else if (q.format === "md") {
      res.type("text/markdown; charset=utf-8").attachment(`${file}.md`).send(md);
    } else {
      res.json({ data: { ref, pack: JSON.parse(json), markdown: md } });
    }
  });

  r.post("/runs/:id/land", async (req, res) => {
    const ctx = ctxOf(res); requireUser(ctx);
    const id = idOf(req.params.id);
    if (!(LAND_ROLES as readonly string[]).includes(ctx.role ?? "")) { // W6 regra 1: papel antes de qualquer leitura do alvo
      landWarn(id, ctx, "forbidden_role", `role=${ctx.role ?? "null"}`);
      throw new HttpError(403, "forbidden_role", { required: [...LAND_ROLES] });
    }
    const b = landSchema.parse(req.body ?? {});
    const out = await withTenant(pool, ctx.tenantId, (c) => landRun(c, ctx, id, b));
    res.status(out.land.mode === "created" ? 201 : 200).json({ data: { run: runOut(out.run), land: out.land } });
  });
  return r;
}
