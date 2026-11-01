// W6 · Task 12 — harden land (papel + link só vínculo válido via 0017, sem oráculo), warn de kind (readiness + /api/policies),
// 409 steps_out_of_order (wire 0.3.9). Fixtures via owner; API via app (RLS, NOBYPASSRLS).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { createApp } from "../../src/http/app.js";
import { makePool, withTenant } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import { POLICY_KIND_UNKNOWN_WHY } from "../../src/domain/policy-kinds.js";
import { setupTwoTenants } from "./helpers.js";

const pool = makePool(env.databaseUrl);
const owner = new pg.Client({ connectionString: env.migrationDatabaseUrl });
type Who = { tenantId: string; userId: string | null };
let server: { close(): void }, base = "", dir = "";
async function call(who: Who | null, method: string, p: string, body?: unknown) {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (who) h["x-tenant-id"] = who.tenantId;
  if (who?.userId) h["x-user-id"] = who.userId;
  const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}
const q = (sql: string, p: unknown[] = []) => owner.query(sql, p).then((r) => r.rows);
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
const J = "/api/journey/runs";
const GHOST = "00000000-0000-4000-8000-000000000000";

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "journey-w6-"));
  process.env.JOURNEY_EXPORT_DIR = dir;
  await owner.connect();
  server = createApp(pool).listen(0);
  await new Promise<void>((r) => (server as unknown as { once(e: string, f: () => void): void }).once("listening", r));
  base = `http://127.0.0.1:${((server as unknown as { address(): AddressInfo }).address()).port}`;
});
after(async () => { server.close(); await owner.end(); await pool.end(); rmSync(dir, { recursive: true, force: true }); });

async function tenants() {
  const t = await setupTwoTenants();
  return { A: { tenantId: t.a.tenantId, userId: t.a.adminUserId }, B: { tenantId: t.b.tenantId, userId: t.b.adminUserId } };
}
async function addUser(tenantId: string, email: string, role: string): Promise<string> {
  return (await q("INSERT INTO users (tenant_id, email, display_name, role) VALUES ($1,$2,'U',$3) RETURNING id", [tenantId, email, role]))[0].id;
}
/** journey em conviction com sign-off (pronta p/ land). */
async function ready(A: Who) {
  const r = await call(A, "POST", J, {}); assert.equal(r.status, 201, JSON.stringify(r.json));
  const id = r.json.data.id as string;
  assert.equal((await call(A, "POST", `${J}/${id}/snapshot`)).status, 200);
  for (const s of ["leverage", "consensus", "roles"]) assert.equal((await call(A, "POST", `${J}/${id}/steps/${s}/complete`, {})).status, 200);
  assert.equal((await call(A, "POST", `${J}/${id}/conviction`)).status, 200);
  assert.equal((await call(A, "POST", `${J}/${id}/steps/conviction/complete`, {})).status, 200);
  return id;
}
const landAudits = (tenantId: string, id: string) =>
  q("SELECT actor_role, payload FROM audit_log WHERE tenant_id = $1 AND entity = 'journey_runs' AND entity_id = $2 AND payload->>'action' = 'land'", [tenantId, id]);

test("0017: journey_land_link SECURITY DEFINER, EXECUTE só ibp_app (sem PUBLIC), search_path fixo; recusa journey fora de conviction", async () => {
  const { A, B } = await tenants(); // migrate antes de ler pg_proc
  const [fn] = await q(`SELECT prosecdef, proconfig, has_function_privilege('ibp_app', oid, 'EXECUTE') app,
    has_function_privilege('public', oid, 'EXECUTE') pub FROM pg_proc WHERE proname = 'journey_land_link'`);
  assert.deepEqual([fn.prosecdef, fn.app, fn.pub], [true, true, false]);
  assert.ok((fn.proconfig as string[]).some((x) => x.startsWith("search_path=")));
  const id = (await call(A, "POST", J, {})).json.data.id;
  await assert.rejects(withTenant(pool, A.tenantId, (c) => c.query("SELECT journey_land_link($1, $2, $3)", [id, B.tenantId, A.userId])),
    /não está em conviction/);
  // grants de tabela inalterados (sem DELETE; sem SELECT cross-tenant novo)
  const g = (await q("SELECT privilege_type p FROM information_schema.role_table_grants WHERE table_name = 'journey_runs' AND grantee = 'ibp_app' ORDER BY 1")).map((r) => r.p);
  assert.deepEqual(g, ["INSERT", "SELECT", "UPDATE"]);
});

test("steps: fora de ordem → 409 steps_out_of_order {stepId, requires, missing} (wire 0.3.9); sequência em ordem ok", async () => {
  const { A } = await tenants();
  const id = (await call(A, "POST", J, {})).json.data.id;
  // checagens anteriores do W5 mantêm a precedência (snapshot_required antes da ordem)
  assert.equal((await call(A, "POST", `${J}/${id}/steps/consensus/complete`, {})).json.error, "snapshot_required");
  assert.equal((await call(A, "POST", `${J}/${id}/snapshot`)).status, 200);
  const c1 = await call(A, "POST", `${J}/${id}/steps/consensus/complete`, {});
  assert.deepEqual([c1.status, c1.json.error, c1.json.details], [409, "steps_out_of_order", { stepId: "consensus", requires: "leverage", missing: ["leverage"] }]);
  const r1 = await call(A, "POST", `${J}/${id}/steps/roles/complete`, {});
  assert.deepEqual([r1.status, r1.json.details], [409, { stepId: "roles", requires: "consensus", missing: ["leverage", "consensus"] }]);
  assert.equal((await call(A, "POST", `${J}/${id}/steps/leverage/complete`, {})).status, 200);
  const r2 = await call(A, "POST", `${J}/${id}/steps/roles/complete`, {});
  assert.deepEqual([r2.status, r2.json.details], [409, { stepId: "roles", requires: "consensus", missing: ["consensus"] }]);
  assert.equal((await call(A, "POST", `${J}/${id}/steps/consensus/complete`, {})).status, 200);
  assert.equal((await call(A, "POST", `${J}/${id}/steps/roles/complete`, {})).status, 200);
  const run = (await call(A, "GET", `${J}/${id}`)).json.data;
  assert.deepEqual(run.steps.map((s: any) => s.status), ["done", "done", "done", "pending"]);
  // nada foi gravado pelos 409 (só 3 step_done no audit)
  const n = await q("SELECT count(*)::int n FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND payload->>'action' = 'step_done'", [A.tenantId, id]);
  assert.equal(n[0].n, 3);
});

test("land papel: sales/finance/supply → 403 forbidden_role {required} (thin e link), nada gravado; domain_owner → thin 201", async () => {
  const { A, B } = await tenants();
  const id = await ready(A);
  for (const role of ["sales", "finance", "supply"]) {
    const S = { tenantId: A.tenantId, userId: await addUser(A.tenantId, `${role}-${uniq()}@a.test`, role) };
    for (const body of [{}, { landTenantId: B.tenantId }, { landTenantId: GHOST }]) {
      const r = await call(S, "POST", `${J}/${id}/land`, body);
      assert.deepEqual([r.status, r.json.error, r.json.details], [403, "forbidden_role", { required: ["admin", "domain_owner"] }], `${role} ${JSON.stringify(body)}`);
    }
  }
  assert.equal((await call({ tenantId: A.tenantId, userId: null }, "POST", `${J}/${id}/land`, {})).status, 401);
  assert.equal((await call(A, "GET", `${J}/${id}`)).json.data.status, "conviction");
  assert.equal((await landAudits(A.tenantId, id)).length, 0);
  const D = { tenantId: A.tenantId, userId: await addUser(A.tenantId, `do-${uniq()}@a.test`, "domain_owner") };
  const ok = await call(D, "POST", `${J}/${id}/land`, { slug: `land-do-${uniq()}` });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const au = await landAudits(A.tenantId, id);
  assert.deepEqual([au.length, au[0].actor_role, au[0].payload.mode], [1, "domain_owner", "created"]);
});

test("land link sem oráculo: inexistente ≡ sem vínculo ≡ mesmo e-mail não-admin no alvo (400 byte-igual); admin no alvo → 200 link", async () => {
  const { A, B } = await tenants();
  const id = await ready(A);
  const [aMail] = await q("SELECT email FROM users WHERE id = $1", [A.userId]);
  const ghost = await call(A, "POST", `${J}/${id}/land`, { landTenantId: GHOST });
  const noLink = await call(A, "POST", `${J}/${id}/land`, { landTenantId: B.tenantId });
  assert.deepEqual([ghost.status, ghost.json.error, ghost.json.details], [400, "invalid_reference", { field: "landTenantId" }]);
  assert.equal(noLink.status, 400);
  assert.equal(noLink.text, ghost.text, "corpo idêntico: inexistente × existente sem vínculo");
  // mesmo e-mail no alvo mas papel ≠ admin → mesma recusa
  await addUser(B.tenantId, String(aMail.email).toUpperCase(), "finance");
  const notAdmin = await call(A, "POST", `${J}/${id}/land`, { landTenantId: B.tenantId });
  assert.equal(notAdmin.text, ghost.text);
  assert.equal((await call(A, "POST", `${J}/${id}/land`, { landTenantId: A.tenantId })).json.error, "land_is_lab");
  assert.equal((await call(A, "GET", `${J}/${id}`)).json.data.status, "conviction");
  assert.equal((await landAudits(A.tenantId, id)).length, 0);
  // vínculo: o mesmo e-mail (case-insensitive) vira admin no alvo
  await q("UPDATE users SET role = 'admin' WHERE tenant_id = $1 AND lower(email) = lower($2)", [B.tenantId, aMail.email]);
  const ok = await call(A, "POST", `${J}/${id}/land`, { landTenantId: B.tenantId });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.data.land.mode, ok.json.data.land.tenantId, ok.json.data.run.status, ok.json.data.run.landTenantId],
    ["link", B.tenantId, "landed", B.tenantId]);
  const au = await landAudits(A.tenantId, id);
  assert.deepEqual([au.length, au[0].actor_role, au[0].payload.mode], [1, "admin", "link"]);
  // nada do alvo foi copiado/escrito
  assert.equal((await q("SELECT count(*)::int n FROM journey_runs WHERE tenant_id = $1", [B.tenantId]))[0].n, 0);
});

test("land link: domain_owner do lab cujo e-mail é admin no alvo → 200 (papel no lab ∈ LAND_ROLES; vínculo pelo e-mail)", async () => {
  const { A, B } = await tenants();
  const id = await ready(A);
  const mail = `do-${uniq()}@shared.test`;
  const D = { tenantId: A.tenantId, userId: await addUser(A.tenantId, mail, "domain_owner") };
  await addUser(B.tenantId, mail, "admin");
  const ok = await call(D, "POST", `${J}/${id}/land`, { landTenantId: B.tenantId });
  assert.deepEqual([ok.status, ok.json.data?.land?.mode], [200, "link"]);
});

test("0017 sem BYPASSRLS: dono NOBYPASSRLS lê users do alvo sob RLS do alvo e devolve app.tenant_id ao lab", async () => {
  const { A, B } = await tenants();
  const [aMail] = await q("SELECT email FROM users WHERE id = $1", [A.userId]);
  await addUser(B.tenantId, aMail.email, "admin");
  const [{ id }] = await q("INSERT INTO journey_runs (tenant_id, code, status) VALUES ($1, $2, 'conviction') RETURNING id", [A.tenantId, `NB-${uniq()}`]);
  const role = `ibp_link_nobypass_${uniq()}`;
  await owner.query("BEGIN");
  try {
    await owner.query("SELECT pg_advisory_xact_lock(hashtext('ibp_schema_migrations'))");
    await owner.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await owner.query(`GRANT SELECT ON users TO ${role}`);
    await owner.query(`GRANT SELECT, UPDATE ON journey_runs TO ${role}`);
    await owner.query(`ALTER FUNCTION journey_land_link(uuid, uuid, uuid) OWNER TO ${role}`);
    await owner.query("SET LOCAL ROLE ibp_app");
    await owner.query("SELECT set_config('app.tenant_id', $1, true)", [A.tenantId]);
    const ok = (await owner.query("SELECT journey_land_link($1, $2, $3) ok", [id, B.tenantId, A.userId])).rows[0].ok;
    assert.equal(ok, true, "admin no alvo visto sob RLS do alvo");
    assert.equal((await owner.query("SELECT current_setting('app.tenant_id') t")).rows[0].t, A.tenantId, "fn restaura o lab");
    assert.equal((await owner.query("SELECT journey_land_link($1, $2, $3) ok", [id, GHOST, A.userId])).rows[0].ok, false);
    assert.equal((await owner.query("SELECT current_setting('app.tenant_id') t")).rows[0].t, A.tenantId);
    // app continua sem enxergar users do alvo
    assert.equal((await owner.query("SELECT count(*)::int n FROM users WHERE tenant_id = $1", [B.tenantId])).rows[0].n, 0);
  } finally {
    await owner.query("ROLLBACK");
  }
});

test("warn de kind: POST/PATCH /api/policies devolvem warnings[policy_kind_unknown] (mesmo status); readiness warn (nunca block); A4 inalterado", async () => {
  const { A } = await tenants();
  const known = await call(A, "POST", "/api/policies", { kind: "estoque", name: "e", body: {} });
  assert.equal(known.status, 201);
  assert.equal(known.json.warnings, undefined, "kind legado sem warn");
  const unk = await call(A, "POST", "/api/policies", { kind: "Mágico X", name: "m", body: {} });
  assert.equal(unk.status, 201, JSON.stringify(unk.json));
  assert.deepEqual(unk.json.warnings, [{ code: "policy_kind_unknown", kind: "magico_x", why: POLICY_KIND_UNKNOWN_WHY }]);
  const pt = await call(A, "PATCH", `/api/policies/${unk.json.data.id}`, { body: { note: "v2" }, why: "ajusta" });
  assert.equal(pt.status, 200);
  assert.deepEqual(pt.json.warnings, unk.json.warnings);
  const ptk = await call(A, "PATCH", `/api/policies/${known.json.data.id}`, { body: { note: "v2" }, why: "ajusta" });
  assert.equal(ptk.json.warnings, undefined);
  // readiness: block pelo item (falta nó/rota), mas o warning aparece com why; política desconhecida não conta
  const r = (await call(A, "GET", "/api/a4-readiness")).json.data;
  const w = r.warnings.find((x: any) => x.kind === "policy_kind_unknown");
  assert.deepEqual([w.by, w.why], [[pt.json.data.stable_id ?? unk.json.data.id], POLICY_KIND_UNKNOWN_WHY]);
  assert.equal(r.items.find((i: any) => i.key === "policy").status, "falta");
  // vocabulário do tenant (F-1): magico_x no grupo service → deixa de ser desconhecido
  await q("UPDATE tenant_settings SET policy_kinds = $2::jsonb WHERE tenant_id = $1",
    [A.tenantId, JSON.stringify({ working_capital: ["wc"], inventory: ["estoque"], service: ["magico_x"] })]);
  const r2 = (await call(A, "GET", "/api/a4-readiness")).json.data;
  assert.equal(r2.warnings.some((x: any) => x.kind === "policy_kind_unknown"), false);
  assert.equal(r2.items.find((i: any) => i.key === "policy").status, "ok");
});
