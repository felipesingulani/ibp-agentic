// A7 stub (Task 7): máquina de estados pura + regra do porquê. Sem banco, sem rede.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type DecisionFacts, type RunFacts, WHY_MIN_STRICT, actorRoleOf, evaluateDecision, whyMinFor } from "../../src/a7/decision.js";
import { HttpError } from "../../src/http/errors.js";

const t0 = new Date("2026-10-30T04:00:00Z");
const run = (o: Partial<RunFacts> = {}): RunFacts =>
  ({ id: "r1", scenarioId: "s1", scenarioVersion: 1, dbStatus: "feasible", reasons: [], startedAt: t0, ...o });
const facts = (o: Partial<DecisionFacts> = {}): DecisionFacts => ({
  scenario: { id: "s1", version: 1, status: "draft" }, run: run(), lastPremiseChangeAt: new Date(t0.getTime() - 1000),
  events: [], actorRole: "domain_owner", ...o });
const rejects = (fn: () => unknown, status: number, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === status && e.message === code, code);
const LONG = "Aprovo: CD1 complementa; risco aceito.";

test("approve/escalate happy path → next state", () => {
  assert.equal(evaluateDecision("approve", "ok", facts()).next, "approved");
  assert.equal(evaluateDecision("escalate", "ok", facts({ run: null })).next, "escalated");
});

test("why: required always; ≥20 with warn/block reasons or partial; 1 only when feasible + no warn/block", () => {
  rejects(() => evaluateDecision("approve", "   ", facts()), 400, "why_required");
  assert.equal(whyMinFor(run({ reasons: [{ severity: "info" }] })).min, 1);
  for (const r of [run({ reasons: [{ severity: "warn" }] }), run({ reasons: [{ severity: "block" }] }), run({ dbStatus: "partial" })]) {
    assert.equal(whyMinFor(r).min, WHY_MIN_STRICT);
    rejects(() => evaluateDecision("approve", "curto demais", facts({ run: r })), 400, "why_too_short");
    rejects(() => evaluateDecision("escalate", "curto demais", facts({ run: r })), 400, "why_too_short");
    assert.equal(evaluateDecision("approve", LONG, facts({ run: r })).next, "approved");
  }
  // 19 chars após trim não passa; 20 passa
  const w = run({ reasons: [{ severity: "warn" }] });
  rejects(() => evaluateDecision("approve", "  " + "x".repeat(19) + "  ", facts({ run: w })), 400, "why_too_short");
  evaluateDecision("approve", "x".repeat(20), facts({ run: w }));
});

test("approve preconditions: run required, done, same scenario, not stale", () => {
  rejects(() => evaluateDecision("approve", "ok", facts({ run: null })), 400, "run_required");
  for (const s of ["queued", "running", "failed", "discarded"]) {
    rejects(() => evaluateDecision("approve", "ok", facts({ run: run({ dbStatus: s }) })), 409, "run_not_done");
  }
  rejects(() => evaluateDecision("approve", "ok", facts({ run: run({ scenarioId: "other" }) })), 400, "invalid_reference");
  rejects(() => evaluateDecision("approve", "ok", facts({ scenario: { id: "s1", version: 2, status: "draft" } })), 409, "run_stale");
  rejects(() => evaluateDecision("approve", "ok", facts({ scenario: { id: "s1", version: 1, status: "stale" } })), 409, "run_stale");
  rejects(() => evaluateDecision("approve", "ok", facts({ lastPremiseChangeAt: new Date(t0.getTime() + 1) })), 409, "run_stale");
});

test("escalate: stale/failed run allowed, unfinished run not", () => {
  assert.equal(evaluateDecision("escalate", "ok", facts({ lastPremiseChangeAt: new Date(t0.getTime() + 1) })).next, "escalated");
  assert.equal(evaluateDecision("escalate", "ok", facts({ run: run({ dbStatus: "failed" }) })).next, "escalated");
  rejects(() => evaluateDecision("escalate", "ok", facts({ run: run({ dbStatus: "running" }) })), 409, "run_not_finished");
});

test("transitions: approved is closed; escalated → approve only by domain_owner; no double escalate; archived blocks", () => {
  rejects(() => evaluateDecision("escalate", "ok", facts({ events: [{ action: "approve" }] })), 409, "decision_closed");
  rejects(() => evaluateDecision("approve", "ok", facts({ events: [{ action: "approve" }] })), 409, "decision_closed");
  rejects(() => evaluateDecision("escalate", "ok", facts({ events: [{ action: "escalate" }] })), 409, "already_escalated");
  rejects(() => evaluateDecision("approve", "ok", facts({ events: [{ action: "escalate" }], actorRole: "finance" })), 403, "escalated_to_domain_owner");
  assert.equal(evaluateDecision("approve", "ok", facts({ events: [{ action: "escalate" }] })).next, "approved");
  rejects(() => evaluateDecision("escalate", "ok", facts({ scenario: { id: "s1", version: 1, status: "archived" } })), 409, "scenario_archived");
});

test("actor role: admin → domain_owner; contract roles pass; system/unknown refused for humans", () => {
  assert.equal(actorRoleOf("admin"), "domain_owner");
  for (const r of ["domain_owner", "sales", "supply", "finance"]) assert.equal(actorRoleOf(r), r);
  rejects(() => actorRoleOf("system"), 403, "decision_forbidden");
  rejects(() => actorRoleOf(null), 403, "decision_forbidden");
});
