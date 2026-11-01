// Regra de labels (PO + Deivid 2026-10-30, W3 contract §KPI tipado): Kpi.label é SEMPRE string não vazia — nunca null.
// Precedência: tenant_settings.kpi_labels (escrito pelo pack/PUT) → kpi_labels do pack do tenant (NULL ≡ generic) → default pt-BR do catálogo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { KPI_LABEL_DEFAULTS, VISAO_ALLOWLIST, labelOf, makeKpi, svcKpi, wcKpi } from "../../src/w3/kpi.js";

const bare = { currency: null, uom: null, kpi_labels: {} };
const none = { basis: "none", scenarioId: null, scenarioVersion: null, runId: null, at: null } as const;

test("allowlist V0 (Deivid) + board: todo key tem default pt-BR não vazio", () => {
  assert.deepEqual([...VISAO_ALLOWLIST], ["demand_3p", "util_avg", "util_max", "gaps_net", "contracts_n", "invest_mi", "nodes_n", "scenarios_n"]);
  for (const k of [...VISAO_ALLOWLIST, "svc", "cost", "viol", "wc"] as const) {
    assert.equal(typeof KPI_LABEL_DEFAULTS[k], "string"); assert.ok(KPI_LABEL_DEFAULTS[k].trim().length > 0, k);
  }
  assert.equal(KPI_LABEL_DEFAULTS.demand_3p, "Demanda dos últimos 3 períodos"); // = KPI_CATALOG wire 0.3.7
});

test("tenant sem settings: board e visões nunca null; {cap} resolvido pelo pack generic", () => {
  assert.equal(svcKpi(bare, none, null).label, "OTIF");          // generic pack kpi_labels
  assert.equal(wcKpi(bare).label, "Working capital");
  assert.equal(labelOf(bare, "util_avg"), "Utilização média de armazenagem");
  for (const k of ["nodes_current", "scenarios_sales", "network_gaps", "contracts_current", "contract_reasons", "volume_premises",
    "pending_alcada", "adherence", "invest_mi"] as const) {
    const l = makeKpi(bare, k, 1, "count", null, "x").label;
    assert.ok(typeof l === "string" && l.length > 0 && !l.includes("{"), `${k} → ${l}`);
  }
});

test("precedência: tenant kpi_labels › pack do tenant › default; vazio/espaço/não-string não vale; alias do allowlist/wire", () => {
  assert.equal(svcKpi({ ...bare, pack: "retail" }, none, null).label, "Fill rate");
  assert.equal(svcKpi({ ...bare, pack: "retail", kpi_labels: { svc: "Serviço" } }, none, null).label, "Serviço");
  assert.equal(svcKpi({ ...bare, kpi_labels: { svc: "  " } }, none, null).label, "OTIF");
  assert.equal(svcKpi({ ...bare, kpi_labels: { svc: 7 } }, none, null).label, "OTIF");
  assert.equal(labelOf({ ...bare, kpi_labels: { nodes_n: "Terminais" } }, "nodes_current"), "Terminais"); // alias allowlist
  assert.equal(labelOf({ ...bare, kpi_labels: { inv_mi: "Capex" } }, "invest_mi"), "Capex");                // alias wire
  assert.equal(labelOf({ ...bare, kpi_labels: { nodes_current: "A", nodes_n: "B" } }, "nodes_current"), "A"); // key exata vence alias
  assert.equal(labelOf({ ...bare, capacity: "tancagem" }, "util_max"), "Utilização máx. de tancagem");
  assert.equal(labelOf({ ...bare, pack: "nao_existe" }, "svc"), "OTIF"); // pack desconhecido → generic
});
