/**
 * T-A7-LEVE — A7 orchestrator leve (docs/architecture/A7-ORCHESTRATOR-LEVE-CONTRACT.md). Tenant via header + RLS.
 *   POST /api/a7/evaluate {scenarioId, commit?=false} (strict)
 *     → 200 a7.orch.v1 (contracts/a7-orchestration.schema.json): verdict auto_policy|escalate_human|await_inputs
 *       + provocations (A1–A3/A5/A6, nunca A4) + package {premises, violations, options} + basis + committedEventId
 *     · 400 validation_failed|commit_not_allowed · 404 not_found · 409 scenario_archived|a7_disabled|decision_closed|already_escalated
 *   commit=false: só leitura (nenhum INSERT). commit=true: DecisionEvent actor.role=system (approve p/ auto_policy, escalate p/
 *   escalate_human) + pacote completo no audit_log.payload da decisão — mesmo lock/INSERT/audit do POST /api/decision-events.
 * x-user-id opcional (registrado como requestedBy no payload). Sem migration/grant novo; sem disparo do A4; sem rede.
 */
import express from "express";
import { z } from "zod";
import { type Client, type Pool, withTenant } from "../db/pool.js";
import { assertA7Orchestration, assertDecisionEvent } from "../a7/contract.js";
import { type RunFacts, decisionState, escalatedTo, runIsStale } from "../a7/decision.js";
import { DECISION_SELECT, type DecisionOut, decisionOut } from "../a7/event-out.js";
import { ORCH_SCHEMA, type OrchFacts, orchestrate, scopeExceptions, whyFor } from "../a7/orchestrate.js";
import { lastPremiseChangeAt } from "../a7/premise-change.js";
import { assertA7Enabled } from "../a7/roster.js";
import { SYSTEM_ACTOR, evaluateSystemDecision } from "../a7/system-decision.js";
import { effectiveAlcadaMi, loadAlcadaPolicy, loadScenarioImpact, requiresFinance } from "../w3/alcada.js";
import { loadW3 } from "../w3/snapshot.js";
import { type Ctx, type Row, audit, ctxOf } from "./common.js";
import { HttpError } from "./errors.js";

const bodySchema = z.object({ scenarioId: z.uuid(), commit: z.boolean().optional().default(false) }).strict();

const runFacts = (r: Row): RunFacts => ({ id: String(r.id), scenarioId: String(r.scenario_id), scenarioVersion: Number(r.scenario_version),
  dbStatus: String(r.status), reasons: Array.isArray(r.reasons) ? r.reasons : [], startedAt: new Date(r.started_at as string) });

async function loadFacts(c: Client, sc: Row) {
  const sid = String(sc.id), version = Number(sc.version);
  const snap = await loadW3(c); // exceptions/readiness/cards: mesma fonte do Pulse (sem SQL de exceptions duplicado)
  const runs = (await c.query(
    "SELECT * FROM a4_runs WHERE scenario_id = $1 AND scenario_version = $2 ORDER BY started_at DESC, id DESC", [sid, version])).rows;
  const done = runs.find((r) => r.status === "feasible" || r.status === "partial");
  const run = done ? runFacts(done) : null;
  const scenario = { id: sid, version, status: String(sc.status) };
  const events = (await c.query(`${DECISION_SELECT} WHERE d.scenario_id = $1 AND d.scenario_version = $2 ORDER BY d.at, d.id`,
    [sid, version])).rows.map(decisionOut);
  const premiseAt = await lastPremiseChangeAt(c, sid);
  const { mode, policy } = await loadAlcadaPolicy(c);
  const imp = await loadScenarioImpact(c, sid);
  const needsFinance = requiresFinance(mode, policy, imp);
  const alcadaMi = needsFinance ? effectiveAlcadaMi(mode, policy) : (mode === "active" ? policy?.alcadaMi ?? null : null);
  const facts: OrchFacts = {
    scenario, run, latestRunStatus: runs[0] ? String(runs[0].status) : null,
    runStale: runIsStale({ scenario, run, lastPremiseChangeAt: premiseAt }),
    readinessState: snap.readiness.state, exceptions: scopeExceptions(snap.exceptions, sid),
    requiresFinance: needsFinance, alcadaMode: mode, impactMi: imp.impactMi, alcadaMi,
    decisionState: decisionState(events), escalatedTo: escalatedTo(events),
    cards: snap.cards.filter((k) => String(k.scenario_id) === sid).map((k) => ({
      id: String(k.id), type: String(k.type), status: String(k.status), version: Number(k.version ?? 1), fields: k.fields })),
  };
  return { facts, events, premiseAt, mode, policy };
}

export function a7Router(pool: Pool) {
  const r = express.Router();

  r.post("/evaluate", async (req, res) => {
    const ctx = ctxOf(res);
    const body = bodySchema.parse(req.body ?? {});
    const out = await withTenant(pool, ctx.tenantId, async (c) => {
      // commit serializa com o POST humano de decision-events (mesmo lock por cenário)
      if (body.commit) await c.query("SELECT pg_advisory_xact_lock(hashtextextended('decision:' || $1, 0))", [body.scenarioId]);
      const sc = (await c.query("SELECT * FROM scenarios WHERE id = $1 AND is_current", [body.scenarioId])).rows[0];
      if (!sc) throw new HttpError(404, "not_found", { field: "scenarioId" });
      if (sc.status === "archived") throw new HttpError(409, "scenario_archived");
      await assertA7Enabled(c);
      const { facts, events, premiseAt, mode, policy } = await loadFacts(c, sc);
      const o = orchestrate(facts);
      let committedEventId: string | null = null;
      if (body.commit) {
        if (facts.decisionState === "approved") throw new HttpError(409, "decision_closed", { state: "approved" });
        if (o.verdict === "await_inputs") throw new HttpError(400, "commit_not_allowed", { verdict: o.verdict, code: o.code });
        const action = o.verdict === "auto_policy" ? "approve" : "escalate";
        const why = whyFor(o.verdict, o.code);
        const { next, escalateTo } = evaluateSystemDecision(action, why, {
          scenario: facts.scenario, run: facts.run, lastPremiseChangeAt: premiseAt, events, requiresFinance: facts.requiresFinance });
        const ins = (await c.query(
          `INSERT INTO decision_events (tenant_id, scenario_id, scenario_version, run_id, action, why, actor_user_id, actor_role)
           VALUES ($1, $2, $3, $4, $5, $6, NULL, $7) RETURNING *`,
          [ctx.tenantId, facts.scenario.id, facts.scenario.version, facts.run?.id ?? null, action, why, SYSTEM_ACTOR])).rows[0];
        const v02 = { impactMi: facts.impactMi, alcadaMi: facts.alcadaMi, escalateTo };
        const ev: DecisionOut = { ...decisionOut(ins), ...v02 };
        assertDecisionEvent(ev); // falha → rollback
        const sys: Ctx = { tenantId: ctx.tenantId, userId: null, role: SYSTEM_ACTOR };
        await audit(c, sys, action, "decision_events", ev.id, {
          scenario_id: facts.scenario.id, scenario_version: facts.scenario.version, run_id: ev.runId, why, state: next, ...v02,
          alcada: { mode, policyRef: policy ? { id: policy.id, version: policy.version } : null, requiresFinance: facts.requiresFinance },
          a7: { schema: ORCH_SCHEMA, verdict: o.verdict, code: o.code, reasons: o.reasons, provocations: o.provocations,
            package: o.package, basis: o.basis, requestedBy: ctx.userId },
        });
        committedEventId = ev.id;
      }
      const resp = { schema: ORCH_SCHEMA, scenarioId: facts.scenario.id, scenarioVersion: facts.scenario.version, verdict: o.verdict,
        provocations: o.provocations, package: o.package, basis: o.basis, committedEventId };
      assertA7Orchestration(resp); // fora do contrato → 500 + rollback do commit
      return resp;
    });
    res.json(out);
  });
  return r;
}
