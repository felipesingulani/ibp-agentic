// W7 · Task 13 — funções puras do export do plano aprovado: payload (plan cru − reasonCandidates), CSV longo, filename, contrato.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CSV_COLUMNS, EXPORT_ROLES, EXPORT_VERSION, assertPlanExport, parseExportFormat } from "../../src/plans/contract.js";
import { buildPlanExport, exportFilename, toCsv } from "../../src/plans/export.js";
import { HttpError } from "../../src/http/errors.js";

const planRef = { basis: "approved" as const, scenarioId: "11111111-1111-4111-8111-111111111111", scenarioVersion: 3,
  runId: "22222222-2222-4222-8222-222222222222", at: "2026-10-30T06:00:00.000Z" };
const run = { run_code: "R-1", status: "feasible", started_at: "2026-10-30T05:00:00.000Z", finished_at: "2026-10-30T05:00:02.000Z" };
const rawPlan = {
  objective: 1234.5, solverStatus: "Optimal", wallMs: 42, period: "2026-11",
  totals: { demand: 100, served: 90.25, unmet: 9.75, fillRate: 0.9025 },
  flows: [{ routeId: "r1", routeCode: "CD,SP", skuId: "k1", skuCode: 'K"1', qty: 50.125 }],
  local: [{ nodeId: "n1", skuId: "k1", qty: 40.125 }],
  unmet: [{ nodeId: "n2", skuId: "k1", qty: 9.75 }],
  utilization: [{ nodeId: "n1", code: "Fábrica São Paulo", used: 90.25, capacity: 100, pct: 90.3 }],
  params: { weights: { unmet: 1000 } }, reasonCandidates: 7,
};
const mk = (plan: unknown = rawPlan, settings = { currency: "BRL", uom: null }) =>
  buildPlanExport({ planRef, run, settings, plan, exportedAt: "2026-10-30T06:40:00.000Z" });

test("papéis cravados PO = admin + domain_owner + finance; formatos json|csv", () => {
  assert.deepEqual([...EXPORT_ROLES], ["admin", "domain_owner", "finance"]);
  assert.equal(parseExportFormat("json"), "json"); assert.equal(parseExportFormat("csv"), "csv");
  for (const bad of [undefined, "", "xlsx", "JSON", ["json", "csv"]]) {
    assert.throws(() => parseExportFormat(bad), (e: unknown) => e instanceof HttpError && e.status === 400
      && e.message === "validation_failed" && (e.details as { field: string }).field === "format");
  }
});

test("payload: plan = a4_runs.plan cru menos reasonCandidates (params fica); planRef intacto; contrato ajv ok", () => {
  const p = mk();
  assert.equal(p.exportVersion, EXPORT_VERSION);
  assert.deepEqual(p.planRef, planRef);
  assert.deepEqual(p.run, { runCode: "R-1", status: "feasible", startedAt: run.started_at, finishedAt: run.finished_at });
  assert.deepEqual(p.settings, { currency: "BRL", uom: null });
  const { reasonCandidates: _rc, ...expected } = rawPlan;
  assert.deepEqual(p.plan, expected);
  assert.ok(!("reasonCandidates" in (p.plan as object)));
  assert.ok("reasonCandidates" in rawPlan, "não muta o objeto de origem");
  assertPlanExport(p);
  assert.throws(() => assertPlanExport({ ...p, planRef: { ...planRef, basis: "latest_run" } }));
  assert.throws(() => assertPlanExport({ ...p, plan: { ...rawPlan } })); // reasonCandidates vazado → fora do contrato
  assert.throws(() => assertPlanExport({ ...p, extra: 1 }));
});

test("CSV: linha # planRef, header fixo, seções na ordem, RFC 4180, números crus, null → vazio", () => {
  const csv = toCsv(mk());
  const lines = csv.split("\r\n");
  assert.equal(lines.at(-1), ""); // termina em CRLF
  assert.equal(lines[0], `# exportVersion=w7.v0;basis=approved;scenarioId=${planRef.scenarioId};scenarioVersion=3;runId=${planRef.runId};`
    + `runCode=R-1;approvedAt=${planRef.at};exportedAt=2026-10-30T06:40:00.000Z;currency=BRL;uom=`);
  assert.equal(lines[1], CSV_COLUMNS.join(","));
  assert.equal(lines[1], "section,metric,node_id,node_code,route_id,route_code,sku_id,sku_code,qty,used,capacity,pct,value");
  const body = lines.slice(2, -1);
  assert.deepEqual(body, [
    "total,objective,,,,,,,,,,,1234.5",
    "total,period,,,,,,,,,,,2026-11",
    "total,solverStatus,,,,,,,,,,,Optimal",
    "total,demand,,,,,,,,,,,100",
    "total,served,,,,,,,,,,,90.25",
    "total,unmet,,,,,,,,,,,9.75",
    "total,fillRate,,,,,,,,,,,0.9025",
    'flow,,,,r1,"CD,SP",k1,"K""1",50.125,,,,',
    "local,,n1,,,,k1,,40.125,,,,",
    "unmet,,n2,,,,k1,,9.75,,,,",
    "utilization,,n1,Fábrica São Paulo,,,,,,90.25,100,90.3,",
  ]);
  for (const l of body) assert.equal(l.replace(/"[^"]*"/g, "").split(",").length, 13, l);
});

test("CSV: null/ausente → célula vazia (nunca 0 nem 'null'); plano sem arrays → só totais", () => {
  const csv = toCsv(mk({ objective: null, solverStatus: "Optimal", period: null, totals: { demand: 0, served: 0, unmet: 0, fillRate: null } },
    { currency: null as unknown as string, uom: null }));
  assert.ok(!/null/.test(csv), csv);
  const lines = csv.split("\r\n");
  assert.ok(lines[0].endsWith(";currency=;uom="));
  assert.deepEqual(lines.slice(2, -1), [
    "total,objective,,,,,,,,,,,", "total,period,,,,,,,,,,,", "total,solverStatus,,,,,,,,,,,Optimal",
    "total,demand,,,,,,,,,,,0", "total,served,,,,,,,,,,,0", "total,unmet,,,,,,,,,,,0", "total,fillRate,,,,,,,,,,,",
  ]);
  const quoted = toCsv(mk({ ...rawPlan, utilization: [{ nodeId: "n1", code: "A\nB", used: 1, capacity: 2, pct: 50 }] }));
  assert.ok(quoted.includes('utilization,,n1,"A\nB",,,,,,1,2,50,'));
});

test("filename: plan-<scenarioId>-v<version>-<runCode>.<ext> só [A-Za-z0-9._-]", () => {
  assert.equal(exportFilename(mk(), "json"), `plan-${planRef.scenarioId}-v3-R-1.json`);
  const p = mk(); p.run.runCode = 'R "x"/../ç;1';
  const f = exportFilename(p, "csv");
  assert.match(f, /^[A-Za-z0-9._-]+$/);
  assert.ok(f.endsWith(".csv") && f.startsWith(`plan-${planRef.scenarioId}-v3-`));
});

test("CSV guarda de fórmula: string = + - @ → prefixo '; números negativos crus; JSON intacto", () => {
  const evil = { ...rawPlan,
    flows: [{ routeId: "=HYPERLINK(1)", routeCode: "+R", skuId: "-k", skuCode: "@SUM(A1)", qty: -1.5 }],
    local: [], unmet: [], utilization: [{ nodeId: "n1", code: "=1,2", used: -2, capacity: 0, pct: -0.5 }] };
  const p = mk(evil);
  const csv = toCsv(p);
  assert.ok(csv.includes("flow,,,,'=HYPERLINK(1),'+R,'-k,'@SUM(A1),-1.5,,,,"), csv);
  assert.ok(csv.includes(`utilization,,n1,"'=1,2",,,,,,-2,0,-0.5,`), csv);
  assert.ok(csv.includes("total,solverStatus,,,,,,,,,,,Optimal"));
  const f = (p.plan as { flows: Array<Record<string, unknown>> }).flows[0];
  assert.equal(f.routeId, "=HYPERLINK(1)"); assert.equal(f.skuCode, "@SUM(A1)"); assert.equal(f.qty, -1.5);
  assert.ok(!JSON.stringify(p).includes("'="));
});
