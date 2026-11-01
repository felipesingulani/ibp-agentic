// W6 · Task 12 — funções puras: ordem forçada dos steps (wire 0.3.9), papel do land, warn de kind fora do vocabulário (F-1 intacto).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LAND_ROLES, initialSteps, stepOrderGap, type Step } from "../../src/journey/contract.js";
import { computeReadiness, type ReadinessFacts } from "../../src/domain/a4Readiness.js";
import { POLICY_KIND_UNKNOWN_WHY, effectivePolicyKinds, isKnownKind, policyKindWarnings } from "../../src/domain/policy-kinds.js";

const done = (s: Step[], ...ids: string[]) => s.map((x) => (ids.includes(x.id) ? { ...x, status: "done" as const, at: "t" } : x));

test("steps: ordem forçada leverage → consensus → roles → conviction; gap = {stepId, requires (anterior), missing (todos pendentes antes)}", () => {
  const s0 = initialSteps();
  assert.equal(stepOrderGap(s0, "leverage"), null);
  assert.deepEqual(stepOrderGap(s0, "consensus"), { stepId: "consensus", requires: "leverage", missing: ["leverage"] });
  assert.deepEqual(stepOrderGap(s0, "roles"), { stepId: "roles", requires: "consensus", missing: ["leverage", "consensus"] });
  assert.deepEqual(stepOrderGap(s0, "conviction"), { stepId: "conviction", requires: "roles", missing: ["leverage", "consensus", "roles"] });
  assert.deepEqual(stepOrderGap(done(s0, "consensus"), "roles"), { stepId: "roles", requires: "consensus", missing: ["leverage"] });
  assert.equal(stepOrderGap(done(s0, "leverage"), "consensus"), null);
  assert.equal(stepOrderGap(done(s0, "leverage", "consensus"), "roles"), null);
  assert.equal(stepOrderGap(done(s0, "leverage", "consensus", "roles"), "conviction"), null);
});

test("land: papéis cravados PO = admin + domain_owner", () => {
  assert.deepEqual([...LAND_ROLES], ["admin", "domain_owner"]);
});

test("kind: conhecido ⇔ normalizado ∈ algum grupo efetivo; legado {} inclui alcada; pack sem alcada → alcada desconhecido", () => {
  const legacy = effectivePolicyKinds({});
  for (const k of ["Working capital", "Estoque", "Serviço", "Alçada", "wc"]) assert.equal(isKnownKind(legacy, k), true, k);
  assert.equal(isKnownKind(legacy, "fill_rate"), false);
  const retail = effectivePolicyKinds({ service: ["fill_rate"], inventory: ["estoque"], working_capital: ["wc"] });
  assert.equal(isKnownKind(retail, "Fill-Rate"), true);
  assert.equal(isKnownKind(retail, "alcada"), false);
  assert.deepEqual(policyKindWarnings(legacy, "Working capital"), []);
  assert.deepEqual(policyKindWarnings(legacy, "Mágico X"), [{ code: "policy_kind_unknown", kind: "magico_x", why: POLICY_KIND_UNKNOWN_WHY }]);
});

const base: ReadinessFacts = { policies: [{ stable_id: "p", kind: "working_capital" }], nodesWithCapacity: ["n"], skus: ["s"], routes: ["r"],
  contracts: [], supplyExternalInScope: false };

test("readiness: kind fora do vocabulário → warning policy_kind_unknown {label, by, why}; warn (nunca block); F-1 intacto", () => {
  assert.deepEqual(computeReadiness(base).warnings, []);
  const r = computeReadiness({ ...base, policies: [...base.policies, { stable_id: "x1", kind: "Mágico" }, { stable_id: "x2", kind: "outro kind" }] });
  assert.equal(r.state, "warn");
  const w = r.warnings.find((x) => x.kind === "policy_kind_unknown")!;
  assert.deepEqual(w.by, ["x1", "x2"]);
  assert.equal(w.why, POLICY_KIND_UNKNOWN_WHY);
  assert.match(w.label, /magico/);
  assert.match(w.label, /outro_kind/);
  // só kind desconhecido + item exigido faltando → block continua sendo pelo item, não pelo warn
  const blk = computeReadiness({ ...base, policies: [{ stable_id: "x1", kind: "Mágico" }] });
  assert.equal(blk.state, "block");
  assert.equal(blk.items.find((i) => i.key === "policy")!.status, "falta"); // desconhecido não alimenta a política (F-1)
  // legado {} sem warn p/ kinds legados (inclui alcada)
  assert.equal(computeReadiness({ ...base, policies: [...base.policies, { stable_id: "a", kind: "alcada" }] }).state, "ok");
  // vocabulário do tenant: fill_rate conhecido no retail, desconhecido no legado
  const retail = effectivePolicyKinds({ service: ["fill_rate"], inventory: ["estoque"], working_capital: ["wc"] });
  const pol = [...base.policies.map((p) => ({ ...p, kind: "wc" })), { stable_id: "f", kind: "fill_rate" }];
  assert.equal(computeReadiness({ ...base, policies: pol, policyKinds: retail }).state, "ok");
  assert.equal(computeReadiness({ ...base, policies: pol }).warnings[0].kind, "policy_kind_unknown");
});
