// T-A7-LEVE: orchestrator leve puro — matriz dos 3 vereditos, provocations stub (A4 nunca, dedupe), pacote/opções, decisão system.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunFacts } from "../../src/a7/decision.js";
import { type OrchFacts, buildProvocations, decideVerdict, orchestrate, scopeExceptions, whyFor } from "../../src/a7/orchestrate.js";
import { evaluateSystemDecision } from "../../src/a7/system-decision.js";
import type { PulseException } from "../../src/w3/exceptions.js";
import { HttpError } from "../../src/http/errors.js";

const t0 = new Date("2026-10-31T10:00:00Z");
const run = (o: Partial<RunFacts> = {}): RunFacts =>
  ({ id: "r1", scenarioId: "s1", scenarioVersion: 1, dbStatus: "feasible", reasons: [], startedAt: t0, ...o });
const exc = (o: Partial<PulseException> = {}): PulseException => ({ id: "x1", source: "premise_gap", kind: "capacidade", severity: "warn",
  summary: "Gap aberto", refs: { nodeId: null, skuId: null, routeId: null, period: null }, scenarioId: "s1", action: "open_scenario", merged: [], ...o });
const facts = (o: Partial<OrchFacts> = {}): OrchFacts => ({
  scenario: { id: "s1", version: 1, status: "draft" }, run: run(), latestRunStatus: "feasible", runStale: false, readinessState: "ok",
  exceptions: [], requiresFinance: false, alcadaMode: "active", impactMi: null, alcadaMi: 10, decisionState: "pending", escalatedTo: null,
  cards: [], gatesState: "ok", deltaMc: 1, ...o });
const rejects = (fn: () => unknown, status: number, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === status && e.message === code, code);

test("matriz await_inputs: sem run · stale · readiness block · exception readiness block (precede escalate)", () => {
  for (const [f, code] of [
    [facts({ run: null }), "no_run"], [facts({ runStale: true }), "run_stale"], [facts({ readinessState: "block" }), "readiness_block"],
    [facts({ exceptions: [exc({ id: "readiness:sku", source: "readiness", kind: "outro", severity: "block", scenarioId: null })] }), "readiness_exception"],
    [facts({ run: null, requiresFinance: true, decisionState: "escalated" }), "no_run"],
  ] as const) {
    const v = decideVerdict(f);
    assert.equal(v.verdict, "await_inputs"); assert.equal(v.code, code);
  }
});

test("matriz escalate_human: requiresFinance · block exception · partial · reason warn|block · já escalado; approved → fail-closed", () => {
  for (const [f, code] of [
    [facts({ requiresFinance: true }), "requires_finance"],
    [facts({ exceptions: [exc({ source: "execution", severity: "block" })] }), "block_exception"],
    [facts({ run: run({ dbStatus: "partial" }) }), "run_partial"],
    [facts({ run: run({ reasons: [{ severity: "warn" }] }) }), "run_reasons"],
    [facts({ run: run({ reasons: [{ severity: "block" }] }) }), "run_reasons"],
    [facts({ decisionState: "escalated", escalatedTo: "domain_owner" }), "already_escalated"],
    [facts({ decisionState: "approved" }), "decision_closed"],
  ] as const) {
    const v = decideVerdict(f);
    assert.equal(v.verdict, "escalate_human", code); assert.equal(v.code, code);
  }
});

test("matriz auto_policy: pending + feasible + ¬stale + ¬finance + 0 block + reasons só info; warn de exceção não bloqueia", () => {
  for (const f of [facts(), facts({ run: run({ reasons: [{ severity: "info" }] }) }), facts({ exceptions: [exc()] }), facts({ readinessState: "warn" })]) {
    assert.deepEqual(decideVerdict(f), { verdict: "auto_policy", code: "clean", reasons: ["clean"] });
  }
  assert.equal(whyFor("auto_policy", "clean"), "a7.auto_policy.v1:clean");
  assert.equal(whyFor("escalate_human", "requires_finance"), "a7.escalate.v1:requires_finance");
});

test("scopeExceptions: só do cenário + readiness/alcada globais block (warn global e outro cenário ficam fora)", () => {
  const all = [exc({ id: "a" }), exc({ id: "b", scenarioId: "s2" }),
    exc({ id: "c", source: "readiness", severity: "block", scenarioId: null }),
    exc({ id: "d", source: "readiness", severity: "warn", scenarioId: null }),
    exc({ id: "e", source: "alcada", severity: "warn", scenarioId: null })];
  assert.deepEqual(scopeExceptions(all, "s1").map((e) => e.id), ["a", "c"]);
});

test("provocations: A1 curva gap, A2 supply_gap, A3 execução, A5 alçada/policy/misconfig, A6 por exceção; A4 nunca; dedupe", () => {
  const curva = (id: string, gapCode: string | null) =>
    ({ id, type: "CurvaDemanda", status: gapCode ? "gap" : "ok", version: 1, fields: { schema: "a1.curva.v1", gapCode } });
  const f = facts({
    cards: [curva("c1", "hist_none"), curva("c2", "hist_insufficient"), curva("c3", "anchor_missing"), curva("c4", null),
      { id: "c5", type: "CurvaDemanda", status: "gap", version: 1, fields: { gapCode: "hist_none" } }], // legado sem schema → não provoca
    exceptions: [exc({ id: "premise_gap:g1" }), exc({ id: "premise_gap:g1" }), exc({ id: "exec:1", source: "execution", severity: "block" }),
      exc({ id: "readiness:node_capacity", source: "readiness", kind: "capacidade", severity: "block", scenarioId: null })],
    run: run({ reasons: [{ severity: "warn", rank: 1 } as never, { severity: "info" }] }),
    requiresFinance: true, alcadaMode: "misconfigured", impactMi: 5, alcadaMi: 0,
  });
  const p = buildProvocations(f);
  const keys = p.map((x) => `${x.agent}:${x.code}:${x.detail.id ?? ""}`);
  assert.ok(!p.some((x) => (x.agent as string) === "A4"));
  assert.deepEqual(keys.filter((k) => k.startsWith("A1")), ["A1:need_curve:c1", "A1:hist_gap:c2", "A1:anchor_missing:c3"]);
  assert.deepEqual(keys.filter((k) => k.startsWith("A2")), ["A2:supply_gap:premise_gap:g1", "A2:supply_gap:readiness:node_capacity"]);
  assert.deepEqual(keys.filter((k) => k.startsWith("A3")), ["A3:execution_exception:exec:1"]);
  assert.deepEqual(keys.filter((k) => k.startsWith("A5")), ["A5:alcada_misconfigured:", "A5:policy_violation:a4_run:r1:1", "A5:alcada_required:"]);
  assert.deepEqual(keys.filter((k) => k.startsWith("A6")),
    ["A6:pulse_exception:premise_gap:g1", "A6:pulse_exception:exec:1", "A6:pulse_exception:readiness:node_capacity"]);
  assert.equal(new Set(keys).size, keys.length, "dedupe (agent, code, detail.id)");
  assert.deepEqual(buildProvocations(facts()), [], "sem provocação aplicável → []");
});

test("pacote: premissas (≤10, Gap/Curva/Investimento primeiro), violações block|warn (≤20), opções acionáveis do basis", () => {
  const cards = [{ id: "n", type: "NovaFilial", status: "ok", version: 1, fields: {} }, { id: "i", type: "Investimento", status: "ok", version: 2, fields: {} },
    { id: "g", type: "Gap", status: "gap", version: 1, fields: {} },
    ...Array.from({ length: 10 }, (_, k) => ({ id: `cd${k}`, type: "CurvaDemanda", status: "ok", version: 1, fields: {} }))];
  const exs = Array.from({ length: 25 }, (_, k) => exc({ id: `e${k}`, severity: k % 3 === 0 ? "info" : "warn" }));
  const o = orchestrate(facts({ cards, exceptions: exs }));
  assert.equal(o.package.premises.length, 10);
  assert.deepEqual(o.package.premises.slice(0, 2), [{ id: "g", type: "Gap", status: "gap", version: 1 }, { id: "cd0", type: "CurvaDemanda", status: "ok", version: 1 }]);
  assert.ok(o.package.violations.length <= 20 && o.package.violations.every((v) => v.severity !== ("info" as string)));
  assert.equal(o.basis.pulseExceptionsCount, 25);
  assert.deepEqual(o.package.options, ["edit_premises"]); // Gap aberto

  assert.deepEqual(orchestrate(facts({ run: null, latestRunStatus: "failed" })).package.options, ["rerun_a4_human"]);
  assert.equal(orchestrate(facts({ run: null, latestRunStatus: "failed" })).basis.runStatus, "failed");
  assert.deepEqual(orchestrate(facts({ readinessState: "block" })).package.options, ["fix_readiness"]);
  assert.deepEqual(orchestrate(facts({ requiresFinance: true })).package.options, ["open_alcada"]);
  assert.deepEqual(orchestrate(facts({ decisionState: "escalated", escalatedTo: "finance", requiresFinance: true })).package.options, ["open_alcada", "wait"]);
  assert.deepEqual(orchestrate(facts()).package, { premises: [], violations: [], options: [] });
  assert.deepEqual(orchestrate(facts()).basis, { hasRun: true, runStatus: "feasible", runStale: false, requiresFinance: false,
    impactMi: null, alcadaMi: 10, decisionState: "pending", pulseExceptionsCount: 0 });
});

test("AR-11: auto_policy exige ΔMC > 0 e gate ≠ block", () => {
  const block = decideVerdict(facts({ gatesState: "block", deltaMc: 1 }));
  assert.equal(block.verdict, "await_inputs");
  assert.equal(block.code, "cadastro_gate_block");
  assert.ok(orchestrate(facts({ gatesState: "block", deltaMc: 1 })).package.options.includes("fix_readiness"));
  const inc = decideVerdict(facts({ deltaMc: null }));
  assert.deepEqual([inc.verdict, inc.code], ["escalate_human", "finance_incomplete"]);
  assert.equal(decideVerdict(facts({ deltaMc: 0 })).code, "no_margin");
  assert.equal(decideVerdict(facts({ deltaMc: -0.2 })).code, "no_margin");
  assert.equal(decideVerdict(facts({ gatesState: "block", deltaMc: null })).code, "cadastro_gate_block");
  assert.equal(decideVerdict(facts({ deltaMc: 0.01 })).verdict, "auto_policy");
  assert.equal(decideVerdict(facts({ decisionState: "approved", deltaMc: null })).code, "decision_closed");
});

test("decisão system: approve aplica pré-condições de run; escalate → finance|domain_owner; approved/escalated → 409", () => {
  const base = { scenario: { id: "s1", version: 1, status: "draft" }, run: run(), lastPremiseChangeAt: null, events: [] as { action: "approve" | "escalate"; escalateTo?: "finance" | "domain_owner" | null }[], requiresFinance: false };
  assert.equal(evaluateSystemDecision("approve", "a7.auto_policy.v1:clean", base).next, "approved");
  rejects(() => evaluateSystemDecision("approve", "a7.auto_policy.v1:clean", { ...base, run: null }), 400, "run_required");
  rejects(() => evaluateSystemDecision("approve", "a7.auto_policy.v1:clean", { ...base, run: run({ scenarioVersion: 0 }) }), 409, "run_stale");
  rejects(() => evaluateSystemDecision("approve", "a7.auto_policy.v1:clean", { ...base, requiresFinance: true }), 403, "alcada_finance_required");
  assert.equal(evaluateSystemDecision("escalate", "a7.escalate.v1:requires_finance", { ...base, requiresFinance: true }).escalateTo, "finance");
  assert.equal(evaluateSystemDecision("escalate", "a7.escalate.v1:run_partial", { ...base, run: run({ dbStatus: "partial" }) }).escalateTo, "domain_owner");
  rejects(() => evaluateSystemDecision("escalate", "a7.escalate.v1:x", { ...base, events: [{ action: "approve" }] }), 409, "decision_closed");
  rejects(() => evaluateSystemDecision("escalate", "a7.escalate.v1:x", { ...base, events: [{ action: "escalate", escalateTo: "finance" }] }), 409, "already_escalated");
});
