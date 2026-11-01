// T-BIZ-CAD-GATES (AR-07): avaliador puro de gates de cadastro — block/warn, escopo e fail-closed.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateGates, resolveScope, type GateFacts, type GateScope,
} from "../../src/cadastro/gates.js";

const N = (code: string, capacity: number | null, extra: Partial<GateFacts["nodes"][number]> = {}) =>
  ({ stable_id: `n-${code}`, code, capacity, ...extra });
const S = (code: string, unit_cost: number | null, unit_price: number | null) =>
  ({ stable_id: `s-${code}`, code, unit_cost, unit_price });
const C = (code: string, skuCodes: string[], o: Partial<GateFacts["contracts"][number]> = {}) =>
  ({ stable_id: `c-${code}`, code, sku_ids: skuCodes.map((k) => `s-${k}`),
    min_volume: null, max_volume: null, valid_from: null, valid_to: null, ...o });

function facts(p: Partial<GateFacts> = {}): GateFacts {
  return {
    period: "2026-10",
    nodes: [], skus: [], contracts: [], financeDrivers: [], premises: [], demand: [],
    servedByCapacitatedOrigin: [],
    ...p,
  };
}
const scopeOf = (nodes: string[], skus: string[] = [], contracts: string[] = []): GateScope =>
  ({ nodes: nodes.map((c) => `n-${c}`), skus: skus.map((c) => `s-${c}`), contracts: contracts.map((c) => `c-${c}`) });

const rules = (f: GateFacts, scope: GateScope) => evaluateGates(f, scope).items.map((i) => `${i.code}:${i.rule}:${i.severity}`);

test("node_without_capacity bloqueia nó do escopo sem capacidade corrente > 0 (FIL-RAO) e monta o CTA", () => {
  const f = facts({ nodes: [N("CD1", 100), N("FIL-RAO", null)] });
  const g = evaluateGates(f, scopeOf(["CD1", "FIL-RAO"]));
  assert.equal(g.state, "block");
  assert.deepEqual(g.items, [{
    entity: "node", stable_id: "n-FIL-RAO", code: "FIL-RAO", rule: "node_without_capacity",
    severity: "block", cta: "/cadastro/nodes/n-FIL-RAO",
  }]);
});

test("capacidade 0 ou ausente bloqueia; capacidade > 0 não", () => {
  const f = facts({ nodes: [N("A", 0), N("B", 0.01), N("C", null)] });
  assert.deepEqual(rules(f, scopeOf(["A", "B", "C"])), ["A:node_without_capacity:block", "C:node_without_capacity:block"]);
});

test("CT-104 sem volume e sem vigência emite os dois blocks; volume ou vigência que cobre o mês livram a regra correspondente", () => {
  const bare = facts({
    period: "2026-10", skus: [S("SKU", 1, 2)],
    contracts: [C("CT-104", ["SKU"])],
  });
  const g = evaluateGates(bare, scopeOf([], ["SKU"], ["CT-104"]));
  assert.equal(g.state, "block");
  assert.deepEqual(g.items.map((i) => i.rule), ["contract_without_volume", "contract_out_of_validity"]);
  assert.ok(g.items.every((i) => i.entity === "contract" && i.code === "CT-104" && i.severity === "block"
    && i.cta === "/cadastro/supplier_contracts/c-CT-104"));

  const volOnly = facts({
    period: "2026-10", skus: [S("SKU", 1, 2)],
    contracts: [C("CT-104", ["SKU"], { min_volume: 0, valid_from: null, valid_to: null })],
  });
  assert.deepEqual(rules(volOnly, scopeOf([], ["SKU"], ["CT-104"])), ["CT-104:contract_out_of_validity:block"]);

  const covered = facts({
    period: "2026-10", skus: [S("SKU", 1, 2)],
    contracts: [C("CT-104", ["SKU"], { max_volume: 10, valid_from: "2026-10-01", valid_to: "2026-10-31" })],
  });
  assert.deepEqual(evaluateGates(covered, scopeOf([], ["SKU"], ["CT-104"])), { state: "ok", items: [] });

  const short = facts({
    period: "2026-10", skus: [S("SKU", 1, 2)],
    contracts: [C("CT-104", ["SKU"], { min_volume: 1, max_volume: 2, valid_from: "2026-10-01", valid_to: "2026-10-30" })],
  });
  assert.deepEqual(rules(short, scopeOf([], ["SKU"], ["CT-104"])), ["CT-104:contract_out_of_validity:block"]);

  const noPeriod = facts({
    period: null, skus: [S("SKU", 1, 2)],
    contracts: [C("CT-104", ["SKU"], { min_volume: 1, valid_from: "2020-01-01", valid_to: "2030-01-01" })],
  });
  assert.deepEqual(rules(noPeriod, scopeOf([], ["SKU"], ["CT-104"])), ["CT-104:contract_out_of_validity:block"]);
});

test("sku_without_cost bloqueia sem custo na premissa e sem unit_cost; sku_without_price só avisa", () => {
  const bare = facts({ skus: [S("SKU-X", null, null)] });
  const g = evaluateGates(bare, scopeOf([], ["SKU-X"]));
  assert.equal(g.state, "block");
  assert.deepEqual(g.items.map((i) => [i.rule, i.severity, i.cta]), [
    ["sku_without_cost", "block", "/cadastro/skus/s-SKU-X"],
    ["sku_without_price", "warn", "/cadastro/skus/s-SKU-X"],
  ]);

  const costOnSku = facts({ skus: [S("SKU-X", 0, null)] });
  assert.deepEqual(rules(costOnSku, scopeOf([], ["SKU-X"])), ["SKU-X:sku_without_price:warn"]);

  const fromPremise = facts({
    skus: [S("SKU-X", null, null)],
    premises: [{ type: "CurvaDemanda", node_id: null, fields: { skuId: "s-SKU-X", unitCost: 4, unitPrice: 9 } }],
  });
  assert.deepEqual(evaluateGates(fromPremise, scopeOf([], ["SKU-X"])), { state: "ok", items: [] });

  const priceOnly = facts({ skus: [S("SKU-X", 3, null)] });
  const w = evaluateGates(priceOnly, scopeOf([], ["SKU-X"]));
  assert.equal(w.state, "warn");
  assert.deepEqual(w.items.map((i) => i.rule), ["sku_without_price"]);
});

test("finance_driver_draft avisa em status draft ou regra vazia; ativo com regra não avisa", () => {
  const draft = facts({ financeDrivers: [{ stable_id: "fd-1", mapping: { "FD-06": { regra: "", status: "draft", driver: "Prazo" } } }] });
  const g = evaluateGates(draft, scopeOf(["CD1"]));
  assert.equal(g.state, "warn");
  assert.deepEqual(g.items, [{
    entity: "finance_driver", stable_id: "fd-1", code: "FD-06", rule: "finance_driver_draft",
    severity: "warn", cta: "/cadastro/finance_drivers/fd-1",
  }]);
  const ok = facts({ financeDrivers: [{ stable_id: "fd-1", mapping: { "FD-01": { regra: "DSO 45", status: "active" } } }] });
  assert.equal(evaluateGates(ok, scopeOf(["X"])).state, "ok");
  const emptyRule = facts({ financeDrivers: [{ stable_id: "fd-1", mapping: { rows: [{ id: "FD-06", regra: "  ", status: "published" }] } }] });
  assert.deepEqual(rules(emptyRule, scopeOf(["X"])), ["FD-06:finance_driver_draft:warn"]);
  const legacyObj = facts({ financeDrivers: [{ stable_id: "fd-1", mapping: { volume: "cash" } }] });
  assert.equal(evaluateGates(legacyObj, scopeOf(["X"])).state, "ok");
});

test("escopo não vazio ignora entidade de fora; escopo vazio é global fail-closed", () => {
  const f = facts({
    nodes: [N("FIL-RAO", null), N("CD1", 100)],
    skus: [S("SKU-X", null, 1)],
    contracts: [C("CT-104", ["SKU-X"])],
  });
  assert.deepEqual(evaluateGates(f, scopeOf(["CD1"])), { state: "ok", items: [] });
  const global = evaluateGates(f, { nodes: [], skus: [], contracts: [] });
  assert.equal(global.state, "block");
  assert.deepEqual(global.items.map((i) => `${i.code}:${i.rule}`), [
    "FIL-RAO:node_without_capacity",
    "CT-104:contract_without_volume",
    "CT-104:contract_out_of_validity",
    "SKU-X:sku_without_cost",
  ]);
});

test("block vence warn; items ordenados por regra, code, stable_id", () => {
  const f = facts({
    nodes: [N("FIL-RAO", null)],
    skus: [S("B", null, null), S("A", 1, null)],
    financeDrivers: [{ stable_id: "fd", mapping: [{ id: "FD-06", status: "draft", regra: "x" }] }],
  });
  const g = evaluateGates(f, { nodes: ["n-FIL-RAO"], skus: ["s-B", "s-A"], contracts: [] });
  assert.equal(g.state, "block");
  assert.deepEqual(g.items.map((i) => `${i.code}:${i.rule}`), [
    "FIL-RAO:node_without_capacity",
    "B:sku_without_cost",
    "A:sku_without_price",
    "B:sku_without_price",
    "FD-06:finance_driver_draft",
  ]);
});

test("resolveScope: premissa NovaFilial/Gap ∪ demanda; sink servido sai do check de capacidade mas entra o SKU; vazio → {}", () => {
  const cd = N("CD1", 100);
  const sink = N("L1", null);
  const rao = N("FIL-RAO", null);
  const sku = S("S1", 2, 3);
  const f = facts({
    nodes: [cd, sink, rao], skus: [sku],
    contracts: [C("CT-104", ["S1"], { min_volume: 1, valid_from: "2026-01-01", valid_to: "2026-12-31" })],
    servedByCapacitatedOrigin: [sink.stable_id],
    demand: [{ node_id: sink.stable_id, sku_id: sku.stable_id, qty: 10 }, { node_id: rao.stable_id, sku_id: sku.stable_id, qty: 1 }],
    premises: [
      { type: "Gap", node_id: rao.stable_id, fields: {} },
      { type: "CurvaDemanda", node_id: sink.stable_id, fields: { sku: "S1" } },
      { type: "NovaFilial", node_id: null, fields: { nodeId: cd.stable_id } },
    ],
  });
  const scope = resolveScope(f);
  assert.deepEqual(new Set(scope.nodes), new Set([rao.stable_id, cd.stable_id]));
  assert.deepEqual(scope.skus, [sku.stable_id]);
  assert.deepEqual(scope.contracts, ["c-CT-104"]);
  const g = evaluateGates(f, scope);
  assert.deepEqual(g.items.map((i) => `${i.code}:${i.rule}`), ["FIL-RAO:node_without_capacity"]);

  const empty = resolveScope(facts());
  assert.deepEqual(empty, { nodes: [], skus: [], contracts: [] });
  assert.equal(evaluateGates(facts({ nodes: [rao] }), empty).state, "block");
});
