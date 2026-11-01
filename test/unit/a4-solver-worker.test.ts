// T-A4-SOLVER-WORKER unit: solver/worker.py real (Python + OR-Tools CBC do venv) — /health, /v1/solve (= stdout cbc_solve.py),
// 401/400/404, fail-closed sem secret; Node solve() via HTTP ≡ spawn local no mesmo modelo do piloto.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { buildModel, paramsFrom, type Snapshot } from "../../src/a4/model.js";
import { solve, solverPython } from "../../src/a4/solve.js";
import { startWorker } from "../support/a4-worker.js";

const SECRET = "test-secret-" + Math.random().toString(36).slice(2);
let w: Awaited<ReturnType<typeof startWorker>>;
before(async () => { w = await startWorker(SECRET); });
after(async () => { await w.stop(); });

const lp = { vars: [{ name: "x", lb: 0, ub: null, obj: 1 }, { name: "y", lb: 0, ub: null, obj: 2 }],
  cons: [{ name: "c", lb: 10, ub: null, coefs: { x: 1, y: 1 } }], timeLimitMs: 1000 };
const post = (body: string, secret: string | null = SECRET, path = "/v1/solve") => fetch(w.url + path, {
  method: "POST", headers: { "content-type": "application/json", ...(secret === null ? {} : { "x-a4-solver-secret": secret }) }, body });

test("GET /health → 200 {ok:true} sem auth", async () => {
  const r = await fetch(w.url + "/health");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test("POST /v1/solve fixture LP → 200 optimal, mesmo JSON (chaves/valores) do stdout de cbc_solve.py", async () => {
  const r = await post(JSON.stringify(lp));
  assert.equal(r.status, 200);
  const out = await r.json() as Record<string, unknown>;
  const cli = JSON.parse(spawnSync(solverPython(), ["solver/cbc_solve.py"], { input: JSON.stringify(lp), encoding: "utf8" }).stdout);
  assert.deepEqual(Object.keys(out).sort(), ["objective", "status", "values", "wallMs"]);
  assert.deepEqual({ ...out, wallMs: 0 }, { ...cli, wallMs: 0 });
  assert.equal(out.status, "optimal");
  assert.equal(out.objective, 10);
});

test("infeasible → 200 status infeasible, objective null, values {} (igual cbc_solve.py)", async () => {
  const bad = { ...lp, cons: [{ name: "c", lb: 10, ub: 5, coefs: { x: 1 } }] };
  const out = await (await post(JSON.stringify(bad))).json() as Record<string, unknown>;
  assert.equal(out.status, "infeasible");
  assert.equal(out.objective, null);
  assert.deepEqual(out.values, {});
});

test("401: secret ausente ou errado", async () => {
  assert.equal((await post(JSON.stringify(lp), null)).status, 401);
  assert.equal((await post(JSON.stringify(lp), "wrong")).status, 401);
  assert.equal((await post(JSON.stringify(lp), "")).status, 401);
});

test("400: JSON inválido / campos faltando / var desconhecida; 404 rota fora do contrato", async () => {
  for (const body of ["{nope", "[]", JSON.stringify({ vars: [] }), JSON.stringify({ vars: [{ lb: 0 }], cons: [] }),
    JSON.stringify({ ...lp, cons: [{ name: "c", coefs: { zz: 1 } }] }), JSON.stringify({ ...lp, timeLimitMs: "5s" })]) {
    const r = await post(body);
    assert.equal(r.status, 400, body);
    assert.ok(typeof (await r.json() as { error: string }).error === "string");
  }
  assert.equal((await post(JSON.stringify(lp), SECRET, "/v1/other")).status, 404);
  assert.equal((await fetch(w.url + "/")).status, 404);
});

test("secret nunca aparece no log do worker", () => {
  assert.ok(w.log().includes("POST"));
  assert.ok(!w.log().includes(SECRET));
});

test("fail-closed: sem A4_SOLVER_SECRET o worker não sobe (exit 2)", () => {
  const r = spawnSync(solverPython(), ["solver/worker.py"], { env: { PATH: process.env.PATH ?? "", PORT: "0" }, encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /A4_SOLVER_SECRET/);
});

test("Node solve() via A4_SOLVER_URL (worker real) ≡ spawn local no LP do piloto", async () => {
  const s: Snapshot = {
    scenario: { id: "sc", version: 1, code: "SC" }, period: "2026-10",
    nodes: [{ id: "cd1", code: "CD1" }, { id: "cd2", code: "CD2" }, { id: "l1", code: "L1" }],
    capacity: { cd1: 100, cd2: 50 },
    routes: [{ id: "r1", code: "R1", origin: "cd1", dest: "l1", cost: 2, leadTimeDays: 1 }, { id: "r2", code: "R2", origin: "cd2", dest: "l1", cost: 5, leadTimeDays: 1 }],
    skus: [{ id: "s1", code: "S1" }], demand: [{ node: "l1", sku: "s1", qty: 160 }],
    policies: [], contracts: [], gapCards: [],
  };
  const m = buildModel(s, paramsFrom(s), 3000);
  const saved = { u: process.env.A4_SOLVER_URL, s: process.env.A4_SOLVER_SECRET };
  try {
    delete process.env.A4_SOLVER_URL;
    const local = await solve(m);
    process.env.A4_SOLVER_URL = w.url;
    process.env.A4_SOLVER_SECRET = SECRET;
    const remote = await solve(m);
    assert.equal(remote.status, "optimal");
    assert.deepEqual({ ...remote, wallMs: 0 }, { ...local, wallMs: 0 });
  } finally {
    if (saved.u === undefined) delete process.env.A4_SOLVER_URL; else process.env.A4_SOLVER_URL = saved.u;
    if (saved.s === undefined) delete process.env.A4_SOLVER_SECRET; else process.env.A4_SOLVER_SECRET = saved.s;
  }
});
