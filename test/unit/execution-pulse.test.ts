// W4 · Task 10 — regras puras de execução: buckets dia, limiar 15% fixo, block (planned>0 actual=0), aderência, nunca inventar.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXEC_THRESHOLD, adherence, bucketize, executionExceptions, kindToReason, type MovementFact,
} from "../../src/execution/pulse.js";

const RUN = "11111111-1111-4111-8111-111111111111", SC = "22222222-2222-4222-8222-222222222222";
const N1 = "33333333-3333-4333-8333-333333333333";
const m = (o: Partial<MovementFact>): MovementFact => ({ periodStart: "2026-10-26", kind: "ship", nodeId: N1, skuId: null,
  qtyPlanned: 100, qtyActual: 100, ...o });
const ctx = { runId: RUN, scenarioId: SC, basis: "approved" as const, nodeCodes: new Map([[N1, "CD-SP"]]) };

test("limiar V0 = 0.15 fixo; kind → a4-reason (ship/receive/transfer → janela; produce → capacidade; other → outro)", () => {
  assert.equal(EXEC_THRESHOLD, 0.15);
  assert.deepEqual(["ship", "receive", "transfer", "produce", "other"].map((k) => kindToReason(k as MovementFact["kind"])),
    ["janela", "janela", "janela", "capacidade", "outro"]);
});

test("bucketize: dia × kind × nó × sku; soma actual; planned só de linhas com planned (todas null → null)", () => {
  const b = bucketize([m({ qtyActual: 40 }), m({ qtyActual: 50, qtyPlanned: null }), m({ periodStart: "2026-10-27", qtyPlanned: null, qtyActual: 5 })]);
  assert.equal(b.length, 2);
  assert.deepEqual([b[0].periodStart, b[0].planned, b[0].actual, b[0].rows], ["2026-10-26", 100, 90, 2]);
  assert.deepEqual([b[1].planned, b[1].actual], [null, 5]);
});

test("exceções: >15% → warn; =15% não; planned>0 & actual=0 → block; planned null/0 → nada (não inventa)", () => {
  const ex = executionExceptions(bucketize([
    m({ periodStart: "2026-10-20", qtyActual: 80 }),            // 20% → warn
    m({ periodStart: "2026-10-21", qtyActual: 85 }),            // 15% exato → não
    m({ periodStart: "2026-10-22", qtyActual: 0, kind: "produce" }), // block capacidade
    m({ periodStart: "2026-10-23", qtyPlanned: null, qtyActual: 3 }),
    m({ periodStart: "2026-10-24", qtyPlanned: 0, qtyActual: 3 }),
    m({ periodStart: "2026-10-25", qtyActual: 120 }),           // +20% → warn
  ]), ctx);
  assert.deepEqual(ex.map((e) => [e.refs.period, e.severity, e.kind]),
    [["2026-10-20", "warn", "janela"], ["2026-10-22", "block", "capacidade"], ["2026-10-25", "warn", "janela"]]);
  const e = ex[0];
  assert.equal(e.source, "execution"); assert.equal(e.scenarioId, SC); assert.equal(e.refs.nodeId, N1);
  assert.match(e.summary, /CD-SP/); assert.match(e.summary, /80/); assert.match(e.summary, /100/);
  assert.deepEqual(e.tags, []);
  assert.deepEqual(executionExceptions(bucketize([m({ qtyActual: 0 })]), { ...ctx, basis: "latest_run" })[0].tags, ["unapproved_plan"]);
  assert.deepEqual(executionExceptions([], ctx), []);
});

test("aderência = 1 − Σ|a−p|/Σp nos últimos 7 dias do maior period_start; sem dado → null", () => {
  assert.equal(adherence([]).value, null);
  assert.equal(adherence(bucketize([m({ qtyPlanned: null })])).value, null);
  const a = adherence(bucketize([
    m({ periodStart: "2026-10-26", qtyPlanned: 100, qtyActual: 80 }),
    m({ periodStart: "2026-10-27", qtyPlanned: 100, qtyActual: 110 }),
    m({ periodStart: "2026-10-10", qtyPlanned: 100, qtyActual: 0 }), // fora da janela curta
  ]));
  assert.deepEqual([a.value, a.from, a.to, a.buckets], [0.85, "2026-10-21", "2026-10-27", 2]);
});
