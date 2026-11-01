// W3b · Task 9 — regras puras: vocabulário de kinds por tenant (fallback legado), modos de alçada (4), packs, validação PUT.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LEGACY_POLICY_KINDS, effectivePolicyKinds, inKindGroup } from "../../src/domain/policy-kinds.js";
import { requiresFinance, resolveAlcadaPolicy, effectiveAlcadaMi } from "../../src/w3/alcada.js";
import { computeReadiness } from "../../src/domain/a4Readiness.js";
import { getPack, listPacks } from "../../src/cadastro/packs.js";
import { validateAgentRoster, validateEntityLabels, mergePolicyKinds } from "../../src/cadastro/settings.js";
import { HttpError } from "../../src/http/errors.js";

const P = (kind: string, body: unknown, id = "p1") => ({ stable_id: id, version: 1, kind, body });
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof HttpError ? `${e.status} ${e.message}` : String(e); } return "ok"; };

test("policy_kinds: {} → legado (inclui alcada ≡ generic); objeto do tenant → só ele; sem chave alcada → null (fora do pack)", () => {
  const leg = effectivePolicyKinds({});
  assert.deepEqual(leg.alcada, ["alcada"]);
  assert.deepEqual(leg.service, LEGACY_POLICY_KINDS.service);
  assert.deepEqual(effectivePolicyKinds(null).alcada, ["alcada"]);
  const t = effectivePolicyKinds({ inventory: ["Estoque Tancado"], service: ["nivel_servico"] });
  assert.equal(t.alcada, null);
  assert.deepEqual(t.working_capital, []);
  assert.equal(inKindGroup(t, "estoque-tancado", "inventory"), true);
  assert.equal(inKindGroup(t, "estoque", "inventory"), false);
  assert.equal(inKindGroup(effectivePolicyKinds({ alcada: ["alcada_finance"] }), "Alçada Finance", "alcada"), true);
});

test("modos de alçada: out_of_pack (único fail-open) · no_policy fail-closed · misconfigured · active", () => {
  const inv = { has: true, impactMi: 0.1 };
  const oop = resolveAlcadaPolicy([P("alcada", { limitMi: 5 })], null);
  assert.deepEqual(oop, { mode: "out_of_pack", policy: null });
  assert.equal(requiresFinance(oop.mode, oop.policy, inv), false);
  const np = resolveAlcadaPolicy([P("working_capital", {})], ["alcada", "alcada_finance"]);
  assert.deepEqual(np, { mode: "no_policy", policy: null });
  assert.equal(requiresFinance(np.mode, np.policy, inv), true);
  assert.equal(requiresFinance(np.mode, np.policy, { has: false, impactMi: null }), false);
  assert.equal(effectiveAlcadaMi(np.mode, np.policy), 0);
  const act = resolveAlcadaPolicy([P("alcada_finance", { limitMi: 2 })], ["alcada", "alcada_finance"]);
  assert.equal(act.mode, "active");
  assert.equal(resolveAlcadaPolicy([P("alcada_finance", { limitMi: 2 })], ["alcada"]).mode, "no_policy"); // alias fora do vocabulário
  assert.equal(resolveAlcadaPolicy([P("alcada", { limitMi: null })], ["alcada"]).mode, "misconfigured");
});

test("readiness usa policy_kinds do tenant (fallback legado)", () => {
  const base = { nodesWithCapacity: ["n"], skus: ["s"], routes: ["r"], contracts: [], supplyExternalInScope: false };
  const pol = [{ stable_id: "a", kind: "capital_giro_produto" }];
  assert.equal(computeReadiness({ ...base, policies: pol }).items.find((i) => i.key === "policy")!.status, "falta");
  const r = computeReadiness({ ...base, policies: pol, policyKinds: effectivePolicyKinds({ working_capital: ["capital_giro_produto"] }) });
  assert.equal(r.items.find((i) => i.key === "policy")!.status, "ok");
  assert.match(r.items.find((i) => i.key === "policy")!.rule, /capital_giro_produto/);
});

test("packs: 5 seeds, generic_no_alcada real (sem alcada), demais com alcada default 2 mi", () => {
  const ps = listPacks();
  assert.deepEqual(ps.map((p) => p.id).sort(), ["cpg", "generic", "generic_no_alcada", "oilgas", "retail"]);
  for (const p of ps) {
    assert.equal(p.sim, false);
    assert.equal(p.includesAlcada, p.id !== "generic_no_alcada");
    assert.equal(p.alcadaDefaultMi, p.includesAlcada ? 2 : null);
    for (const k of ["node", "capacity", "route", "sku", "contract"]) assert.ok((p.labels as Record<string, string>)[k]);
  }
  assert.equal(getPack("oilgas")!.uom, "L");
  assert.deepEqual(getPack("oilgas")!.policy_kinds.alcada, ["alcada", "alcada_finance"]);
  assert.equal(getPack("nope"), undefined);
});

test("validação PUT: labels exatas, roster A1..A7 + A4 cbc / A7 state_machine_only, policy_kinds merge + ambiguidade", () => {
  const L = { node: "Nó", capacity: "x", route: "Rota", sku: "SKU", contract: "C" };
  assert.deepEqual(validateEntityLabels({ ...L, node: "  Terminal " }), { ...L, node: "Terminal" });
  assert.equal(code(() => validateEntityLabels({ ...L, extra: "y" })), "400 invalid_labels");
  assert.equal(code(() => validateEntityLabels({ node: "Nó" })), "400 invalid_labels");
  assert.equal(code(() => validateEntityLabels({ ...L, node: "x".repeat(41) })), "400 invalid_labels");
  assert.deepEqual(validateAgentRoster({ A4: { enabled: true, solver: "cbc" } }), { A4: { enabled: true, solver: "cbc" } });
  assert.equal(code(() => validateAgentRoster({ A4: { enabled: true, solver: "highs" } })), "400 invalid_agent_roster");
  assert.equal(code(() => validateAgentRoster({ A7: { enabled: true, mode: "llm" } })), "400 invalid_agent_roster");
  assert.equal(code(() => validateAgentRoster({ A8: { enabled: true } })), "400 invalid_agent_roster");
  assert.equal(code(() => validateAgentRoster({ A1: { enabled: "yes" } })), "400 invalid_agent_roster");
  const leg = {};
  const m = mergePolicyKinds(leg, { inventory: ["Estoque", "lastro", "lastro"] });
  assert.deepEqual(m.inventory, ["estoque", "lastro"]);
  assert.deepEqual(m.alcada, ["alcada"]); // legado materializado
  assert.equal(code(() => mergePolicyKinds(leg, { service: ["estoque"] })), "400 ambiguous_policy_kind");
  assert.equal(code(() => mergePolicyKinds(leg, { foo: ["x"] })), "400 invalid_policy_kinds");
  assert.equal(code(() => mergePolicyKinds(leg, { inventory: [] })), "400 invalid_policy_kinds");
  const noAlc = { working_capital: ["wc"], inventory: ["stock"], service: ["service"] };
  assert.equal(code(() => mergePolicyKinds(noAlc, { alcada: ["alcada"] })), "400 use_pack_endpoint");
  assert.equal(code(() => mergePolicyKinds({ ...noAlc, alcada: ["alcada"] }, { alcada: null })), "400 use_pack_endpoint");
  assert.deepEqual(mergePolicyKinds({ ...noAlc, alcada: ["alcada"] }, { alcada: ["alcada", "aprovacao_fin"] }).alcada, ["alcada", "aprovacao_fin"]);
});
