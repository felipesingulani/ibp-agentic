// W2b · Task 7 — /api/decision-events (A7 stub): approve · escalate · why rules · stale · transitions · RLS · contrato (ajv).
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { createApp } from "../../src/http/app.js";
import { makePool } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import { ownerCreateScenario, setupTwoTenants } from "./helpers.js";
import { validateDecisionEvent } from "../support/schemas.js";

const pool = makePool(env.databaseUrl);
const owner = new pg.Client({ connectionString: env.migrationDatabaseUrl });
type Who = { tenantId: string; userId: string | null };
let A: Who, B: Who, AFin: Who;
let server: { close(): void }, base = "";

async function call(who: Who, method: string, path: string, body?: unknown) {
  const h: Record<string, string> = { "content-type": "application/json", "x-tenant-id": who.tenantId };
  if (who.userId) h["x-user-id"] = who.userId;
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const decide = (who: Who, body: Record<string, unknown>) => call(who, "POST", "/api/decision-events", body);
/** run fixture via owner (resultado do A4 é determinístico; aqui controlamos status/razões). */
async function ownerRun(tenantId: string, scenarioId: string, status: string, reasons: unknown[] = [], version = 1) {
  return (await owner.query(
    `INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status, reasons, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
    [tenantId, `T7-${Math.random().toString(36).slice(2, 8)}`, scenarioId, version, status, JSON.stringify(reasons)])).rows[0].id as string;
}
const warn = [{ rank: 1, kind: "capacidade", summary: "CD1 no limite", refs: {}, severity: "warn" }];
const LONG = "Aprovo: CD1 complementa e o risco de capacidade foi aceito.";
const code = () => `T7-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

before(async () => {
  const t = await setupTwoTenants();
  await owner.connect();
  A = { tenantId: t.a.tenantId, userId: t.a.adminUserId };
  B = { tenantId: t.b.tenantId, userId: t.b.adminUserId };
  const fin = (await owner.query("INSERT INTO users (tenant_id, email, role) VALUES ($1, $2, 'finance') RETURNING id",
    [A.tenantId, `fin-${Date.now()}@a.test`])).rows[0].id;
  AFin = { tenantId: A.tenantId, userId: fin };
  server = createApp(pool).listen(0);
  await new Promise<void>((r) => (server as unknown as { once(e: string, f: () => void): void }).once("listening", r));
  base = `http://127.0.0.1:${((server as unknown as { address(): AddressInfo }).address()).port}`;
});
after(async () => { server.close(); await owner.end(); await pool.end(); });

test("approve: feasible run (no warn) → 201 DecisionEvent (contract), persisted + audit_log, state approved; 2nd decision closed", async () => {
  const sc = await ownerCreateScenario(A.tenantId, code());
  const run = await ownerRun(A.tenantId, sc, "feasible", [{ rank: 1, kind: "custo", summary: "info", refs: {}, severity: "info" }]);
  const r = await decide(A, { scenario_id: sc, run_id: run, action: "approve", why: "ok" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.ok(validateDecisionEvent(r.json.data), JSON.stringify(validateDecisionEvent.errors));
  assert.deepEqual({ ...r.json.data, id: "-", at: "-" }, {
    id: "-", scenarioId: sc, scenarioVersion: 1, runId: run, action: "approve", why: "ok",
    actor: { role: "domain_owner", userId: A.userId }, at: "-", exportRef: null,
    impactMi: null, alcadaMi: null, escalateTo: null }); // v0.2 (Task 8): sem POL de alçada / sem Investimento → null
  assert.equal(r.json.state.state, "approved");
  const db = (await owner.query("SELECT tenant_id, actor_role, why FROM decision_events WHERE id = $1", [r.json.data.id])).rows[0];
  assert.deepEqual(db, { tenant_id: A.tenantId, actor_role: "domain_owner", why: "ok" });
  const au = (await owner.query("SELECT action, actor_role, payload FROM audit_log WHERE entity = 'decision_events' AND entity_id = $1", [r.json.data.id])).rows;
  assert.equal(au.length, 1); assert.equal(au[0].action, "approve"); assert.equal(au[0].actor_role, "admin"); assert.equal(au[0].payload.why, "ok");
  const again = await decide(A, { scenario_id: sc, run_id: run, action: "escalate", why: LONG });
  assert.equal(again.status, 409); assert.equal(again.json.error, "decision_closed");
  const list = await call(A, "GET", `/api/decision-events?scenario_id=${sc}`);
  assert.equal(list.json.count, 1); assert.equal(list.json.state.state, "approved"); assert.equal(list.json.state.latestRunId, run);
  for (const e of list.json.data) assert.ok(validateDecisionEvent(e));
  assert.equal((await call(A, "GET", `/api/decision-events?run_id=${run}`)).json.count, 1);
  assert.equal((await call(A, "GET", `/api/decision-events/${r.json.data.id}`)).json.data.id, r.json.data.id);
});

test("why rules: empty → why_required; warn reasons or partial → ≥20 (why_too_short); trimmed on persist", async () => {
  const sc = await ownerCreateScenario(A.tenantId, code());
  const run = await ownerRun(A.tenantId, sc, "feasible", warn);
  const empty = await decide(A, { scenario_id: sc, run_id: run, action: "approve", why: "   " });
  assert.equal(empty.status, 400); assert.equal(empty.json.error, "why_required");
  const short = await decide(A, { scenario_id: sc, run_id: run, action: "approve", why: "curto" });
  assert.equal(short.status, 400); assert.equal(short.json.error, "why_too_short");
  assert.deepEqual(short.json.details, { field: "why", min: 20, because: "warn_or_block_reasons" });
  const scP = await ownerCreateScenario(A.tenantId, code());
  const partial = await ownerRun(A.tenantId, scP, "partial");
  const p = await decide(A, { scenario_id: scP, run_id: partial, action: "escalate", why: "curto" });
  assert.equal(p.status, 400); assert.equal(p.json.details.because, "run_partial");
  const ok = await decide(A, { scenario_id: sc, run_id: run, action: "approve", why: `  ${LONG}  ` });
  assert.equal(ok.status, 201); assert.equal(ok.json.data.why, LONG);
  const missing = await decide(A, { scenario_id: sc, action: "approve" });
  assert.equal(missing.status, 400); assert.equal(missing.json.error, "validation_failed");
  const bad = await decide(A, { scenario_id: sc, action: "reject", why: LONG });
  assert.equal(bad.status, 400);
});

test("escalate → escalated; finance cannot approve escalated (403); domain owner can; no double escalate", async () => {
  const sc = await ownerCreateScenario(A.tenantId, code());
  const run = await ownerRun(A.tenantId, sc, "feasible", warn);
  const e = await decide(AFin, { scenario_id: sc, run_id: run, action: "escalate", why: "Investimento acima da alçada; sobe p/ owner." });
  assert.equal(e.status, 201); assert.equal(e.json.state.state, "escalated"); assert.equal(e.json.data.actor.role, "finance");
  assert.equal((await decide(A, { scenario_id: sc, action: "escalate", why: LONG })).json.error, "already_escalated");
  const f = await decide(AFin, { scenario_id: sc, run_id: run, action: "approve", why: LONG });
  assert.equal(f.status, 403); assert.equal(f.json.error, "escalated_to_domain_owner");
  const o = await decide(A, { scenario_id: sc, run_id: run, action: "approve", why: LONG });
  assert.equal(o.status, 201); assert.equal(o.json.state.state, "approved");
  const list = await call(A, "GET", `/api/decision-events?scenario_id=${sc}`);
  assert.deepEqual(list.json.data.map((x: { action: string }) => x.action), ["escalate", "approve"]);
});

test("approve guards: run required/done/same scenario; stale (version or premise edited after run) → 409, escalate still allowed", async () => {
  const sc = await ownerCreateScenario(A.tenantId, code());
  assert.equal((await decide(A, { scenario_id: sc, action: "approve", why: LONG })).json.error, "run_required");
  const failed = await ownerRun(A.tenantId, sc, "failed");
  assert.equal((await decide(A, { scenario_id: sc, run_id: failed, action: "approve", why: LONG })).json.error, "run_not_done");
  const other = await ownerCreateScenario(A.tenantId, code());
  const otherRun = await ownerRun(A.tenantId, other, "feasible");
  const x = await decide(A, { scenario_id: sc, run_id: otherRun, action: "approve", why: LONG });
  assert.equal(x.status, 400); assert.equal(x.json.error, "invalid_reference");
  const oldVer = await ownerRun(A.tenantId, sc, "feasible", [], 1);
  await owner.query("UPDATE scenarios SET version = 2 WHERE id = $1", [sc]);
  const st = await decide(A, { scenario_id: sc, run_id: oldVer, action: "approve", why: LONG });
  assert.equal(st.status, 409); assert.equal(st.json.error, "run_stale");
  const run2 = await ownerRun(A.tenantId, sc, "feasible", [], 2);
  await owner.query( // premissa criada/editada depois do início do run → run stale
    `INSERT INTO premise_cards (tenant_id, scenario_id, card_id, type, fields, status, source, created_at)
     VALUES ($1, $2, 'PC-T7', 'CurvaDemanda', '{}', 'ok', 'edit', now() + interval '1 second')`, [A.tenantId, sc]);
  // (W3b: cartão neutro — Investimento em tenant legado = no_policy fail-closed → 403 antes do run_stale)
  const st2 = await decide(A, { scenario_id: sc, run_id: run2, action: "approve", why: LONG });
  assert.equal(st2.status, 409, JSON.stringify(st2.json)); assert.equal(st2.json.error, "run_stale");
  const list = await call(A, "GET", `/api/decision-events?scenario_id=${sc}`);
  assert.equal(list.json.state.latestRunStale, true);
  const esc = await decide(A, { scenario_id: sc, run_id: run2, action: "escalate", why: LONG });
  assert.equal(esc.status, 201); assert.equal(esc.json.data.scenarioVersion, 2);
  const running = await ownerRun(A.tenantId, sc, "running", [], 2);
  const scR = await decide(A, { scenario_id: sc, run_id: running, action: "escalate", why: LONG });
  assert.equal(scR.status, 409); // already_escalated (version 2) precede run_not_finished
});

test("RLS/tenant: B cannot see/decide A's scenario or reference A's run; writes need x-user-id", async () => {
  const sc = await ownerCreateScenario(A.tenantId, code());
  const run = await ownerRun(A.tenantId, sc, "feasible");
  const a = await decide(A, { scenario_id: sc, run_id: run, action: "approve", why: "ok" });
  assert.equal(a.status, 201);
  const b = await decide(B, { scenario_id: sc, run_id: run, action: "escalate", why: LONG });
  assert.equal(b.status, 404); assert.equal(b.json.error, "not_found");
  const scB = await ownerCreateScenario(B.tenantId, code());
  const bx = await decide(B, { scenario_id: scB, run_id: run, action: "escalate", why: LONG });
  assert.equal(bx.status, 400); assert.equal(bx.json.error, "invalid_reference");
  assert.equal((await call(B, "GET", `/api/decision-events?scenario_id=${sc}`)).json.count, 0);
  assert.equal((await call(B, "GET", `/api/decision-events/${a.json.data.id}`)).status, 404);
  assert.equal((await call(B, "GET", "/api/decision-events")).json.data.some((e: { id: string }) => e.id === a.json.data.id), false);
  const anon = await decide({ tenantId: A.tenantId, userId: null }, { scenario_id: sc, action: "escalate", why: LONG });
  assert.equal(anon.status, 401);
  assert.equal((await call(A, "GET", "/api/decision-events?scenario_id=nope")).status, 400);
});
