// W1b: checklist de prontidão A4 (função pura) — ok | falta | n/a e pct = ok ÷ exigidos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReadiness, normalizeKind, type ReadinessFacts } from "../../src/domain/a4Readiness.js";

const empty: ReadinessFacts = { policies: [], nodesWithCapacity: [], skus: [], routes: [], contracts: [], supplyExternalInScope: false };
const st = (r: ReturnType<typeof computeReadiness>) => Object.fromEntries(r.items.map((i) => [i.key, i.status]));

test("empty tenant: required items falta, contract n/a, pct 0, block", () => {
  const r = computeReadiness(empty);
  assert.deepEqual(st(r), { node_capacity: "falta", sku: "falta", route: "falta", supplier_contract: "n/a", policy: "falta" });
  assert.deepEqual([r.met, r.need, r.pct, r.state], [0, 4, 0, "block"]);
});

test("policy: working capital alone OR inventory + service (kind normalized, free text)", () => {
  assert.equal(normalizeKind(" Serviço "), "servico");
  assert.equal(normalizeKind("Working-Capital"), "working_capital");
  const one = (kinds: string[]) => st(computeReadiness({ ...empty, policies: kinds.map((k, i) => ({ stable_id: `p${i}`, kind: k })) })).policy;
  assert.equal(one(["Working capital"]), "ok");
  assert.equal(one(["Estoque"]), "falta");
  assert.equal(one(["Estoque", "Serviço"]), "ok");
  assert.equal(one(["inventory", "service"]), "ok");
  assert.equal(one(["outra_coisa"]), "falta");
});

test("supply external in scope: contract required (falta → ok), pct over 4", () => {
  const base = { ...empty, policies: [{ stable_id: "p", kind: "working_capital" }], nodesWithCapacity: ["n"], skus: ["s"], routes: ["r"] };
  const off = computeReadiness(base);
  assert.deepEqual([off.met, off.need, off.pct, off.state], [4, 4, 100, "ok"]);
  const on = computeReadiness({ ...base, supplyExternalInScope: true });
  assert.equal(st(on).supplier_contract, "falta");
  assert.deepEqual([on.met, on.need, on.pct, on.state], [4, 5, 80, "block"]);
  const full = computeReadiness({ ...base, supplyExternalInScope: true, contracts: ["c"] });
  assert.equal(st(full).supplier_contract, "ok");
  assert.equal(full.state, "ok");
});

test("state warn: all required ok but restrictions (node w/o capacity, open Gap card)", () => {
  const base = { ...empty, policies: [{ stable_id: "p", kind: "working_capital" }], nodesWithCapacity: ["n"], skus: ["s"], routes: ["r"] };
  assert.equal(computeReadiness(base).state, "ok");
  const w = computeReadiness({ ...base, nodesWithoutCapacity: ["n2"], openGapCards: ["g1"] });
  assert.deepEqual([w.state, w.label, w.pct], ["warn", "A4 pronto c/ restrições", 100]);
  assert.deepEqual(w.warnings.map((x) => x.kind), ["node_without_capacity", "open_gap_card"]);
  // block prevalece sobre warn
  assert.equal(computeReadiness({ ...empty, nodesWithoutCapacity: ["n2"] }).state, "block");
});

test("wc label comes from tenant kpi_labels, not hardcoded", () => {
  const r = computeReadiness({ ...empty, wcLabel: "Capital circulante" });
  assert.match(r.items.find((i) => i.key === "policy")!.label, /Capital circulante/);
});

test("coach B (v0.3.10): item sku exigido (≥1 SKU corrente) e ordem canônica node_capacity → sku → route → supplier_contract → policy", () => {
  const r = computeReadiness(empty);
  assert.deepEqual(r.items.map((i) => i.key), ["node_capacity", "sku", "route", "supplier_contract", "policy"]);
  const sku = r.items.find((i) => i.key === "sku")!;
  assert.deepEqual([sku.entity, sku.required, sku.status], ["skus", true, "falta"]);
  const base = { ...empty, policies: [{ stable_id: "p", kind: "working_capital" }], nodesWithCapacity: ["n"], routes: ["r"] };
  const noSku = computeReadiness(base);
  assert.deepEqual([noSku.met, noSku.need, noSku.state], [3, 4, "block"]);
  const ok = computeReadiness({ ...base, skus: ["s1", "s2"] });
  assert.deepEqual([ok.items.find((i) => i.key === "sku")!.status, ok.items.find((i) => i.key === "sku")!.by, ok.state], ["ok", ["s1", "s2"], "ok"]);
});
