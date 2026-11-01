/**
 * W2b · Task 7 — API do evento de decisão (A7 stub, src/a7/decision.ts). Tenant via header + RLS; append-only (grant 0012).
 *   POST /api/decision-events {scenario_id, run_id?, action: approve|escalate, why}
 *        → 201 {data: DecisionEvent (contrato), state}   · 400 why_required|why_too_short|run_required|invalid_reference
 *        · 404 not_found (cenário inexistente/de outro tenant/não corrente) · 403 escalated_to_domain_owner|decision_forbidden
 *        · 409 decision_closed|already_escalated|run_not_done|run_not_finished|run_stale|scenario_archived
 *   GET  /api/decision-events?scenario_id=&run_id=  → {data: DecisionEvent[] (cronológico), state?} (state só com scenario_id)
 *   GET  /api/decision-events/:id                    → {data: DecisionEvent}
 * Sem write-back e sem export ainda: exportRef = null (export do plano é slice seguinte).
 * Task 8 (DecisionEvent v0.2): body aceita `escalate_to?` (finance|domain_owner; tem de bater com o destino derivado).
 *   impactMi/alcadaMi são SEMPRE derivados no servidor (cartões Investimento + POL de alçada — src/w3/alcada.ts), nunca do body;
 *   gravados no payload do audit_log da decisão (append-only, mesma transação) e devolvidos no DecisionEvent.
 *   403 alcada_finance_required (approve acima da alçada por papel ≠ finance) · 403 escalated_to_finance · 400 invalid_escalate_to.
 */
import express from "express";
import { z } from "zod";
import { type Client, type Pool, withTenant } from "../db/pool.js";
import { assertDecisionEvent } from "../a7/contract.js";
import {
  DECISION_ACTIONS, type DecisionFacts, type RunFacts,
  actorRoleOf, decisionState, escalatedTo, evaluateDecision, runIsStale,
} from "../a7/decision.js";
import { lastPremiseChangeAt } from "../a7/premise-change.js";
import { DECISION_SELECT, type DecisionOut, decisionOut } from "../a7/event-out.js";
import { effectiveAlcadaMi, loadAlcadaPolicy, loadScenarioImpact, requiresFinance } from "../w3/alcada.js";
import { type Row, audit, ctxOf, requireUser, uuidRe } from "./common.js";
import { HttpError } from "./errors.js";

const createSchema = z.object({
  scenario_id: z.uuid(),
  run_id: z.uuid().nullable().optional(),
  action: z.enum(DECISION_ACTIONS),
  why: z.string().max(2000),
  escalate_to: z.enum(["finance", "domain_owner"]).nullable().optional(),
}).strict();

export { decisionOut };


async function loadRun(c: Client, runId: string): Promise<RunFacts | null> {
  const r = (await c.query("SELECT * FROM a4_runs WHERE id = $1", [runId])).rows[0];
  if (!r) return null;
  return { id: r.id, scenarioId: r.scenario_id, scenarioVersion: r.scenario_version, dbStatus: r.status,
    reasons: Array.isArray(r.reasons) ? r.reasons : [], startedAt: new Date(r.started_at) };
}

export { lastPremiseChangeAt };

const versionEvents = (c: Client, sc: Row) => c.query(
  `${DECISION_SELECT} WHERE d.scenario_id = $1 AND d.scenario_version = $2 ORDER BY d.at, d.id`,
  [sc.id, sc.version]).then((q) => q.rows.map(decisionOut));

async function stateOf(c: Client, sc: Row) {
  const events = await versionEvents(c, sc);
  const latest = (await c.query(
    `SELECT * FROM a4_runs WHERE scenario_id = $1 AND status IN ('feasible','partial') ORDER BY started_at DESC LIMIT 1`,
    [sc.id])).rows[0];
  const run = latest ? await loadRun(c, latest.id) : null;
  const stale = runIsStale({ scenario: { id: sc.id as string, version: sc.version as number, status: sc.status as string },
    run, lastPremiseChangeAt: await lastPremiseChangeAt(c, sc.id as string) });
  return { scenarioId: sc.id, scenarioVersion: sc.version, state: decisionState(events), escalateTo: escalatedTo(events),
    latestRunId: run?.id ?? null, latestRunStale: run ? stale : null };
}

export function decisionEventsRouter(pool: Pool) {
  const r = express.Router();

  r.post("/", async (req, res) => {
    const ctx = ctxOf(res);
    requireUser(ctx);
    const body = createSchema.parse(req.body ?? {});
    const actorRole = actorRoleOf(ctx.role);
    const out = await withTenant(pool, ctx.tenantId, async (c) => {
      // serializa decisões do mesmo cenário (duas aprovações simultâneas → a 2ª vê decision_closed)
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('decision:' || $1, 0))", [body.scenario_id]);
      const sc = (await c.query("SELECT * FROM scenarios WHERE id = $1 AND is_current", [body.scenario_id])).rows[0];
      if (!sc) throw new HttpError(404, "not_found", { field: "scenario_id" });
      let run: RunFacts | null = null;
      if (body.run_id) {
        run = await loadRun(c, body.run_id);
        if (!run) throw new HttpError(400, "invalid_reference", { field: "run_id" });
      }
      const { mode, policy } = await loadAlcadaPolicy(c);
      const imp = await loadScenarioImpact(c, sc.id);
      const needsFinance = requiresFinance(mode, policy, imp);
      const facts: DecisionFacts = {
        scenario: { id: sc.id, version: sc.version, status: sc.status }, run,
        lastPremiseChangeAt: await lastPremiseChangeAt(c, sc.id), events: await versionEvents(c, sc), actorRole,
        requiresFinance: needsFinance, escalateTo: body.escalate_to ?? null,
      };
      const { next, escalateTo } = evaluateDecision(body.action, body.why, facts);
      const ins = (await c.query(
        `INSERT INTO decision_events (tenant_id, scenario_id, scenario_version, run_id, action, why, actor_user_id, actor_role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [ctx.tenantId, sc.id, sc.version, run?.id ?? null, body.action, body.why.trim(), ctx.userId, actorRole])).rows[0];
      // v0.2: snapshot da alçada no momento da decisão (alcadaMi só se a versão está sob alçada; null = fora/sem POL)
      const v02 = {
        impactMi: imp.impactMi,
        alcadaMi: needsFinance ? effectiveAlcadaMi(mode, policy) : (mode === "active" ? policy?.alcadaMi ?? null : null),
        escalateTo,
      };
      const ev: DecisionOut = { ...decisionOut(ins), ...v02 };
      assertDecisionEvent(ev); // falha → rollback (nunca persiste evento fora do contrato)
      await audit(c, ctx, body.action, "decision_events", ev.id,
        { scenario_id: sc.id, scenario_version: sc.version, run_id: ev.runId, why: ev.why, state: next, ...v02,
          alcada: { mode, policyRef: policy ? { id: policy.id, version: policy.version } : null, requiresFinance: needsFinance } });
      return { data: ev, state: { scenarioId: sc.id, scenarioVersion: sc.version, state: next, escalateTo } };
    });
    res.status(201).json(out);
  });

  r.get("/", async (req, res) => {
    const { scenario_id: sid, run_id: rid } = req.query;
    for (const [k, v] of [["scenario_id", sid], ["run_id", rid]] as const) {
      if (v !== undefined && (typeof v !== "string" || !uuidRe.test(v))) throw new HttpError(400, "invalid_input", { field: k });
    }
    const out = await withTenant(pool, ctxOf(res).tenantId, async (c) => {
      const where: string[] = [], params: unknown[] = [];
      if (sid) { params.push(sid); where.push(`scenario_id = $${params.length}`); }
      if (rid) { params.push(rid); where.push(`run_id = $${params.length}`); }
      const rows = (await c.query(
        `${DECISION_SELECT} ${where.length ? "WHERE " + where.map((x) => "d." + x).join(" AND ") : ""} ORDER BY d.at, d.id LIMIT 500`, params)).rows;
      let state = undefined;
      if (sid) {
        const sc = (await c.query("SELECT * FROM scenarios WHERE id = $1 AND is_current", [sid])).rows[0];
        if (sc) state = await stateOf(c, sc);
      }
      return { data: rows.map(decisionOut), count: rows.length, ...(state ? { state } : {}) };
    });
    res.json(out);
  });

  r.get("/:id", async (req, res) => {
    if (!uuidRe.test(req.params.id)) throw new HttpError(400, "invalid_input", { field: "id" });
    const row = await withTenant(pool, ctxOf(res).tenantId, (c) =>
      c.query(`${DECISION_SELECT} WHERE d.id = $1`, [req.params.id]).then((q) => q.rows[0]));
    if (!row) throw new HttpError(404, "not_found");
    res.json({ data: decisionOut(row) });
  });
  return r;
}
