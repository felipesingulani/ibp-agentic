// T-A4-SOLVER-WORKER unit: solve.ts dual-path — HTTP mock (200/401/5xx/timeout/JSON inválido/rede) → SolveResult ou
// SolverError("solver_unavailable"); preflight /health; URL unset → spawn local (CBC real, regressão W1c).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { REMOTE_TIMEOUT_CAP_MS, SolverError, remoteSolverHealthy, remoteSolverUrl, solve } from "../../src/a4/solve.js";
import type { LpModel } from "../../src/a4/model.js";
import { freePort } from "../support/a4-worker.js";

const model: LpModel = {
  vars: [{ name: "x", lb: 0, ub: null, obj: 1 }, { name: "y", lb: 0, ub: null, obj: 2 }],
  cons: [{ name: "c", lb: 10, ub: null, coefs: { x: 1, y: 1 } }],
  timeLimitMs: 1000,
} as LpModel;
const OK = { status: "optimal", objective: 10, values: { x: 10, y: 0 }, wallMs: 3 };

type Seen = { method?: string; url?: string; secret?: string; body?: string };
async function mock(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void) {
  const seen: Seen = {};
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => { Object.assign(seen, { method: req.method, url: req.url, secret: req.headers["x-a4-solver-secret"], body: b }); handler(req, res, seen); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
const json = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

const saved = { url: process.env.A4_SOLVER_URL, secret: process.env.A4_SOLVER_SECRET };
afterEach(() => {
  for (const [k, v] of [["A4_SOLVER_URL", saved.url], ["A4_SOLVER_SECRET", saved.secret]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
async function unavailable(p: Promise<unknown>) {
  await assert.rejects(p, (e: unknown) => e instanceof SolverError && e.message === "solver_unavailable");
}

test("remoteSolverUrl: unset/vazio → null; barra final removida", () => {
  delete process.env.A4_SOLVER_URL;
  assert.equal(remoteSolverUrl(), null);
  process.env.A4_SOLVER_URL = "  ";
  assert.equal(remoteSolverUrl(), null);
  process.env.A4_SOLVER_URL = "https://a4-solver.example.com//";
  assert.equal(remoteSolverUrl(), "https://a4-solver.example.com");
});

test("A4_SOLVER_URL set + 200 → POST /v1/solve com secret header e body = modelo; SolveResult devolvido", async () => {
  const m = await mock((_q, res) => json(res, 200, OK));
  try {
    process.env.A4_SOLVER_URL = m.url + "/";
    process.env.A4_SOLVER_SECRET = "s3cr3t";
    assert.deepEqual(await solve(model), OK);
    assert.equal(m.seen.method, "POST");
    assert.equal(m.seen.url, "/v1/solve");
    assert.equal(m.seen.secret, "s3cr3t");
    assert.deepEqual(JSON.parse(m.seen.body!), model);
  } finally { await m.close(); }
});

test("200 com status não-ótimo (infeasible, objective null, values {}) passa adiante como hoje", async () => {
  const inf = { status: "infeasible", objective: null, values: {}, wallMs: 1 };
  const m = await mock((_q, res) => json(res, 200, inf));
  try { process.env.A4_SOLVER_URL = m.url; assert.deepEqual(await solve(model), inf); } finally { await m.close(); }
});

test("401 (secret errado) → solver_unavailable", async () => {
  const m = await mock((_q, res, seen) => json(res, seen.secret === "right" ? 200 : 401, seen.secret === "right" ? OK : { error: "unauthorized" }));
  try {
    process.env.A4_SOLVER_URL = m.url;
    process.env.A4_SOLVER_SECRET = "wrong";
    await unavailable(solve(model));
    delete process.env.A4_SOLVER_SECRET; // ausente → header vazio → 401
    await unavailable(solve(model));
  } finally { await m.close(); }
});

test("500 / 503 → solver_unavailable", async () => {
  for (const code of [500, 503]) {
    const m = await mock((_q, res) => json(res, code, { error: "solver_failed" }));
    try { process.env.A4_SOLVER_URL = m.url; await unavailable(solve(model)); } finally { await m.close(); }
  }
});

test("200 com JSON inválido ou shape errado → solver_unavailable", async () => {
  for (const send of [(r: http.ServerResponse) => { r.writeHead(200); r.end("not json"); }, (r: http.ServerResponse) => json(r, 200, { status: "weird" })]) {
    const m = await mock((_q, res) => send(res));
    try { process.env.A4_SOLVER_URL = m.url; await unavailable(solve(model)); } finally { await m.close(); }
  }
});

test("timeout (worker pendurado) → solver_unavailable em ~timeLimitMs+grace; erro sem URL/stack", async () => {
  const m = await mock(() => { /* nunca responde */ });
  try {
    process.env.A4_SOLVER_URL = m.url;
    const t0 = Date.now();
    const err = await solve({ ...model, timeLimitMs: 100 }, { graceMs: 100 }).then(() => null, (e: Error) => e);
    const dt = Date.now() - t0;
    assert.ok(err instanceof SolverError && err.message === "solver_unavailable", String(err));
    assert.ok(!err.message.includes("127.0.0.1"));
    assert.ok(dt >= 150 && dt < 2000, `dt=${dt}`);
  } finally { await m.close(); }
});

test("cap de timeout HTTP = 25s (contrato §1/§4)", () => {
  assert.equal(REMOTE_TIMEOUT_CAP_MS, 25_000);
});

test("rede recusada (worker down) → solver_unavailable", async () => {
  process.env.A4_SOLVER_URL = `http://127.0.0.1:${await freePort()}`;
  await unavailable(solve(model));
});

test("preflight remoteSolverHealthy: 200 {ok:true} → true; 503 / ok≠true / down / pendurado (timeout) → false", async () => {
  const good = await mock((q, res) => json(res, q.url === "/health" ? 200 : 404, { ok: true }));
  const bad = await mock((_q, res) => json(res, 503, { ok: false }));
  const notOk = await mock((_q, res) => json(res, 200, { ok: "yes" }));
  const hang = await mock(() => {});
  try {
    assert.equal(await remoteSolverHealthy(good.url), true);
    assert.equal(good.seen.method, "GET");
    assert.equal(good.seen.secret, undefined, "health sem auth");
    assert.equal(await remoteSolverHealthy(bad.url), false);
    assert.equal(await remoteSolverHealthy(notOk.url), false);
    assert.equal(await remoteSolverHealthy(`http://127.0.0.1:${await freePort()}`), false);
    const t0 = Date.now();
    assert.equal(await remoteSolverHealthy(hang.url, 200), false);
    assert.ok(Date.now() - t0 < 1500);
  } finally { await Promise.all([good.close(), bad.close(), notOk.close(), hang.close()]); }
});

test("A4_SOLVER_URL unset → spawn local (CBC real) — regressão dev/CI", async () => {
  delete process.env.A4_SOLVER_URL;
  const r = await solve(model);
  assert.equal(r.status, "optimal");
  assert.equal(r.objective, 10);
  assert.deepEqual(r.values, { x: 10, y: 0 });
});
