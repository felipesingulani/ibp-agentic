// W3 · Task 8 — regras puras: alçada (modos, impacto, status), transições A7 com alçada, KPIs, dedupe de exceções.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queueStatus, readMi, requiresFinance, resolveAlcadaPolicy, scenarioImpact } from "../../src/w3/alcada.js";
import { evaluateDecision, type DecisionFacts } from "../../src/a7/decision.js";
import { HttpError } from "../../src/http/errors.js";
import { costKpi, svcKpi, violKpi, wcKpi } from "../../src/w3/kpi.js";
import { dedupe, type PulseException } from "../../src/w3/exceptions.js";
import type { DecisionOut } from "../../src/a7/event-out.js";

const P = (kind: string, body: unknown, id = "p1") => ({ stable_id: id, version: 1, kind, body });

test("alçada mode: no_policy (outra kind) · misconfigured (sem limitMi válido) · active (menor limiar)", () => {
  assert.deepEqual(resolveAlcadaPolicy([P("working_capital", { limitMi: 5 })]), { mode: "no_policy", policy: null });
  assert.equal(resolveAlcadaPolicy([P("alcada", {})]).mode, "misconfigured");
  assert.equal(resolveAlcadaPolicy([P("Alçada", { limitMi: "abc" })]).mode, "misconfigured");
  assert.equal(resolveAlcadaPolicy([P("alcada", { limitMi: -1 })]).mode, "misconfigured");
  assert.deepEqual(resolveAlcadaPolicy([P("alcada", { limitMi: 10 }), P("alcada", { limitMi: "2,5" }, "p2")]),
    { mode: "active", policy: { id: "p2", version: 1, alcadaMi: 2.5 } });
  assert.equal(readMi("12.5"), 12.5); assert.equal(readMi("R$ 12"), null); assert.equal(readMi(Number.NaN), null);
});

test("impacto = soma fields.impactMi dos Investimento; ilegível → null; requiresFinance fail-closed", () => {
  const inv = (v: unknown) => ({ type: "Investimento", fields: { impactMi: v } });
  assert.deepEqual(scenarioImpact([{ type: "Gap", fields: {} }]), { has: false, impactMi: null });
  assert.deepEqual(scenarioImpact([inv(1.2), inv("0,3")]), { has: true, impactMi: 1.5 });
  assert.deepEqual(scenarioImpact([inv(1), inv("muito")]), { has: true, impactMi: null });
  const act = resolveAlcadaPolicy([P("alcada", { limitMi: 2 })]);
  assert.equal(requiresFinance(act.mode, act.policy, { has: true, impactMi: 2 }), false); // ≤ não entra
  assert.equal(requiresFinance(act.mode, act.policy, { has: true, impactMi: 2.01 }), true);
  assert.equal(requiresFinance(act.mode, act.policy, { has: true, impactMi: null }), true);
  assert.equal(requiresFinance(act.mode, act.policy, { has: false, impactMi: null }), false);
  const mis = resolveAlcadaPolicy([P("alcada", {})]);
  assert.equal(requiresFinance(mis.mode, mis.policy, { has: true, impactMi: 0 }), true);
  assert.equal(requiresFinance("no_policy", null, { has: true, impactMi: 999 }), true); // W3b: no_policy fail-closed
  assert.equal(requiresFinance("out_of_pack", null, { has: true, impactMi: 999 }), false);
});

test("queueStatus: decisão finance manda; senão superada → stale; approve sem finance → fora", () => {
  const ev = (action: "approve" | "escalate", role: string) => ({ action, actor: { role } }) as unknown as DecisionOut;
  assert.equal(queueStatus([], false), "pending_finance");
  assert.equal(queueStatus([ev("escalate", "sales")], false), "pending_finance");
  assert.equal(queueStatus([ev("approve", "finance")], false), "approved_finance");
  assert.equal(queueStatus([ev("escalate", "finance")], true), "escalated_owner");
  assert.equal(queueStatus([], true), "stale");
  assert.equal(queueStatus([ev("approve", "domain_owner")], false), null);
});

const facts = (over: Partial<DecisionFacts>): DecisionFacts => ({
  scenario: { id: "s", version: 1, status: "ready" }, lastPremiseChangeAt: null, events: [], actorRole: "sales",
  run: { id: "r", scenarioId: "s", scenarioVersion: 1, dbStatus: "feasible", reasons: [], startedAt: new Date() }, ...over,
});
const code = (fn: () => unknown) => { try { fn(); return "ok"; } catch (e) { return (e as HttpError).message; } };
const W = "Investimento acima da alçada; decisão da Finance.";

test("A7 + alçada: Sales não aprova acima da alçada; escalate → finance; Finance aprova ou sobe p/ owner", () => {
  assert.equal(code(() => evaluateDecision("approve", "ok", facts({ requiresFinance: true }))), "alcada_finance_required");
  assert.equal(evaluateDecision("escalate", W, facts({ requiresFinance: true })).escalateTo, "finance");
  assert.equal(code(() => evaluateDecision("escalate", W, facts({ requiresFinance: true, escalateTo: "domain_owner" }))), "invalid_escalate_to");
  assert.equal(evaluateDecision("approve", "ok", facts({ requiresFinance: true, actorRole: "finance" })).next, "approved");
  const toFin = [{ action: "escalate" as const, escalateTo: "finance" as const }];
  assert.equal(code(() => evaluateDecision("approve", W, facts({ events: toFin, actorRole: "domain_owner" }))), "escalated_to_finance");
  assert.equal(evaluateDecision("approve", "ok", facts({ events: toFin, actorRole: "finance" })).next, "approved");
  assert.equal(evaluateDecision("escalate", W, facts({ events: toFin, actorRole: "finance" })).escalateTo, "domain_owner");
  // legado / sem alçada: comportamento Task 7 intacto
  assert.equal(evaluateDecision("approve", "ok", facts({})).escalateTo, null);
  assert.equal(evaluateDecision("escalate", W, facts({})).escalateTo, "domain_owner");
  assert.equal(code(() => evaluateDecision("escalate", W, facts({ events: [{ action: "escalate" }] }))), "already_escalated");
  assert.equal(code(() => evaluateDecision("approve", W, facts({ events: [{ action: "escalate" }], actorRole: "finance" }))), "escalated_to_domain_owner");
});

test("KPIs: nunca inventa (no_plan / no_data / not_computed_v0); cost = objective/served; viol = block+warn", () => {
  const s = { currency: "BRL", uom: "m3", kpi_labels: { svc: "Nível de serviço" } };
  const none = { basis: "none" as const, scenarioId: null, scenarioVersion: null, runId: null, at: null };
  const ref = { ...none, basis: "latest_run" as const };
  assert.deepEqual(svcKpi(s, none, null), { key: "svc", label: "Nível de serviço", value: null, unit: "ratio", nullReason: "no_plan", source: "a4_run.plan.totals.fillRate" });
  assert.equal(svcKpi(s, ref, { totals: { fillRate: 0.9 } }).value, 0.9);
  const c = costKpi(s, ref, { objective: 300, totals: { served: 120 } });
  assert.equal(c.value, 2.5); assert.equal(c.unit, "BRL/m3"); assert.equal(c.label, "Custo logístico"); // labels 2026-10-30: nunca null (default generic)
  assert.equal(costKpi(s, ref, { objective: 300, totals: { served: 0 } }).nullReason, "no_data");
  assert.equal(costKpi({ ...s, uom: null }, ref, { objective: 1, totals: { served: 1 } }).unit, null);
  assert.equal(violKpi(s, { block: 2, warn: 1 }).value, 3);
  assert.equal(wcKpi(s, null).nullReason, "no_plan"); assert.equal(wcKpi(s, null).value, null);
});

test("dedupe: mesmo kind+nodeId → maior severidade (empate: a4_run > readiness > premise_gap > alcada); ordem block>warn>info", () => {
  const e = (id: string, source: PulseException["source"], severity: PulseException["severity"], nodeId: string | null): PulseException =>
    ({ id, source, kind: "capacidade", severity, summary: id, refs: { nodeId, skuId: null, routeId: null, period: null },
      scenarioId: null, action: "open_cadastro", merged: [] });
  const out = dedupe([e("g", "premise_gap", "warn", "N1"), e("r", "readiness", "warn", "N1"), e("a", "a4_run", "block", "N1"),
    e("x", "alcada", "info", null), e("y", "premise_gap", "warn", "N2")]);
  assert.deepEqual(out.map((x) => x.id), ["a", "y", "x"]);
  assert.deepEqual(out[0].merged.sort(), ["g", "r"]);
});
