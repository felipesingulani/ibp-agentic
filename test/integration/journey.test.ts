// W5 · Task 11 — Journey D3: 0015 (FORCE RLS, grants, função de land SECURITY DEFINER), CRUD, snapshot (lab vazio sem número falso ×
// happy path com plano/decisões), steps, conviction (JSON+MD em disco + GET download/404), land (cria thin + pack default | vincula),
// 409 de colisão, RLS cross-tenant. Fixtures via owner; API via app (RLS).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { createApp } from "../../src/http/app.js";
import { makePool, withTenant } from "../../src/db/pool.js";
import { env } from "../../src/config/env.js";
import { ownerCreateScenario, setupTwoTenants } from "./helpers.js";

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
  return { status: res.status, json, text, headers: res.headers };
}
const q = (sql: string, p: unknown[] = []) => owner.query(sql, p).then((r) => r.rows);
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const J = "/api/journey/runs";

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "journey-"));
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
/** lab com plano aprovado (fillRate 0.9), 1 escalate 2h antes do approve, usuário finance + domain_owner. */
async function richLab(A: Who) {
  const sc = await ownerCreateScenario(A.tenantId, `SC-${uniq()}`);
  const run = (await q(`INSERT INTO a4_runs (tenant_id, run_code, scenario_id, scenario_version, status, plan, finished_at)
    VALUES ($1,$2,$3,1,'feasible','{"totals":{"fillRate":0.9}}', now()) RETURNING id`, [A.tenantId, `R-${uniq()}`, sc]))[0].id as string;
  await q(`INSERT INTO decision_events (tenant_id, scenario_id, scenario_version, run_id, action, why, actor_role, at)
    VALUES ($1,$2,1,$3,'escalate','acima da alçada','sales', now() - interval '2 hours'),
           ($1,$2,1,$3,'approve','ok plano','finance', now())`, [A.tenantId, sc, run]);
  await q(`INSERT INTO users (tenant_id, email, display_name, role) VALUES ($1,'fin@a.test','Fin','finance'), ($1,'do@a.test','DO','domain_owner')`, [A.tenantId]);
  const node = (await q("INSERT INTO nodes (tenant_id, code, name, node_type) VALUES ($1,'CD1','CD 1','cd') RETURNING stable_id", [A.tenantId]))[0].stable_id as string;
  return { sc, run, node };
}
async function toConviction(A: Who, body: unknown = {}) {
  const r = await call(A, "POST", J, body); assert.equal(r.status, 201, JSON.stringify(r.json));
  const id = r.json.data.id as string;
  assert.equal((await call(A, "POST", `${J}/${id}/snapshot`)).status, 200);
  for (const s of ["leverage", "consensus", "roles"]) assert.equal((await call(A, "POST", `${J}/${id}/steps/${s}/complete`, {})).status, 200);
  const c = await call(A, "POST", `${J}/${id}/conviction`); assert.equal(c.status, 200, JSON.stringify(c.json));
  return { id, code: r.json.data.code as string, run: c.json.data };
}

test("0015: FORCE RLS, grants SELECT/INSERT/UPDATE (sem DELETE), land fn SECURITY DEFINER só p/ ibp_app e amarrada a journey em conviction", async () => {
  const [rls] = await q("SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE relname = 'journey_runs'");
  assert.deepEqual([rls.r, rls.f], [true, true]);
  const g = (await q("SELECT privilege_type p FROM information_schema.role_table_grants WHERE table_name = 'journey_runs' AND grantee = 'ibp_app' ORDER BY 1")).map((r) => r.p);
  assert.deepEqual(g, ["INSERT", "SELECT", "UPDATE"]);
  const [fn] = await q(`SELECT prosecdef, has_function_privilege('ibp_app', oid, 'EXECUTE') app, has_function_privilege('public', oid, 'EXECUTE') pub
    FROM pg_proc WHERE proname = 'journey_land_tenant'`);
  assert.deepEqual([fn.prosecdef, fn.app, fn.pub], [true, true, false]);
  const { A } = await tenants();
  const id = (await call(A, "POST", J, {})).json.data.id;
  await assert.rejects(withTenant(pool, A.tenantId, (c) => c.query("DELETE FROM journey_runs WHERE id = $1", [id])), /permission denied/);
  // journey ainda open → função recusa (não dá p/ criar tenant fora do fluxo)
  await assert.rejects(withTenant(pool, A.tenantId, (c) => c.query("SELECT * FROM journey_land_tenant($1, 'land-hack', 'x')", [id])),
    /não está em conviction/);
  // app continua sem INSERT direto em tenants
  await assert.rejects(withTenant(pool, A.tenantId, (c) => c.query("INSERT INTO tenants (slug, name) VALUES ('x-hack', 'x')")), /permission denied/);
});

test("lab vazio: snapshot sem número falso (leverage null + nullReason, latência null no_data, gaps de papel); 404/409 de fluxo", async () => {
  const { A } = await tenants();
  const r = await call(A, "POST", J, {});
  assert.equal(r.status, 201);
  const run = r.json.data;
  assert.equal(run.code, "JR-0001");
  assert.equal(run.status, "open");
  assert.deepEqual(run.steps.map((s: any) => [s.id, s.status]), [["leverage", "pending"], ["consensus", "pending"], ["roles", "pending"], ["conviction", "pending"]]);
  assert.equal(run.snapshot, null);
  assert.equal((await call(A, "POST", `${J}/${run.id}/steps/leverage/complete`, {})).json.error, "snapshot_required");
  assert.equal((await call(A, "POST", `${J}/${run.id}/conviction`)).json.error, "snapshot_required");
  const g404 = await call(A, "GET", `${J}/${run.id}/conviction`);
  assert.deepEqual([g404.status, g404.json.error], [404, "conviction_not_generated"]);

  const s = (await call(A, "POST", `${J}/${run.id}/snapshot`)).json.data.snapshot;
  assert.equal(s.planRef.basis, "none");
  assert.deepEqual(s.leverage.points.map((k: any) => [k.key, k.value, k.nullReason]),
    [["wc", null, "no_plan"], ["svc", null, "no_plan"], ["expedite", null, "no_plan"], ["cost", null, "no_plan"], ["adherence", null, "no_plan"]]);
  assert.ok(s.leverage.points.every((k: any) => typeof k.label === "string" && k.label.length > 0));
  assert.deepEqual(s.consensus.decisions, { approve: 0, escalate: 0, total: 0 });
  assert.deepEqual([s.consensus.latency.medianHours, s.consensus.latency.nullReason], [null, "no_data"]);
  assert.deepEqual(s.roles.gaps, ["domain_owner", "sales", "supply", "finance"]);
  assert.equal((await call(A, "POST", `${J}/${run.id}/conviction`)).json.error, "steps_incomplete");
  assert.equal((await call(A, "POST", `${J}/${run.id}/steps/nope/complete`, {})).status, 400);
  assert.equal((await call(A, "POST", `${J}/${run.id}/steps/conviction/complete`, {})).json.error, "conviction_not_generated");
  assert.equal((await call(A, "POST", `${J}/${run.id}/land`, {})).json.error, "journey_invalid_status");
  // conviction pack do lab vazio também não inventa número
  const { id } = await toConviction(A);
  const md = (await call(A, "GET", `${J}/${id}/conviction?format=md`)).text;
  assert.match(md, /Base do plano: sem plano/);
  assert.match(md, /OTIF \| — \(sem plano — rode o A4\)/);
  assert.match(md, /Working capital \| — \(sem plano — rode o A4\)/);
});

test("happy path Qualidade: lab → snapshot (plano aprovado) → steps → conviction (JSON+MD + GET) → sign-off → land cria tenant thin + pack", async () => {
  const { A } = await tenants();
  const { node, run: a4run } = await richLab(A);
  const code = `JR-Q${uniq()}`;
  const cr = await call(A, "POST", J, { code, scope: { bu: "BU Sul", nodeStableIds: [node], skuFamilies: ["F1"] }, sponsorRole: "finance" });
  assert.equal(cr.status, 201, JSON.stringify(cr.json));
  assert.equal((await call(A, "POST", J, { code })).json.error, "journey_code_exists");
  assert.equal((await call(A, "POST", J, { scope: { nodeStableIds: ["00000000-0000-4000-8000-000000000000"] } })).json.error, "invalid_reference");
  assert.equal((await call(A, "POST", J, { code: "bad code" })).status, 400);
  assert.equal((await call({ tenantId: A.tenantId, userId: null }, "POST", J, {})).status, 401);
  const id = cr.json.data.id;

  const snap = (await call(A, "POST", `${J}/${id}/snapshot`)).json.data.snapshot;
  assert.deepEqual([snap.planRef.basis, snap.planRef.runId], ["approved", a4run]);
  const pts = Object.fromEntries(snap.leverage.points.map((k: any) => [k.key, k]));
  assert.equal(pts.svc.value, 0.9);
  assert.deepEqual([pts.wc.value, pts.wc.nullReason], [null, "legacy_run"]);
  assert.deepEqual([pts.expedite.value, pts.expedite.nullReason], [null, "not_computed_v0"]);
  assert.deepEqual(snap.consensus.decisions, { approve: 1, escalate: 1, total: 2 });
  assert.equal(snap.consensus.latency.pairs, 1);
  assert.ok(Math.abs(snap.consensus.latency.medianHours - 2) < 0.02, String(snap.consensus.latency.medianHours));
  assert.deepEqual(snap.roles.gaps, ["sales", "supply"]);
  assert.equal(snap.roles.sponsorRole, "finance");
  // pulse e journey leem o mesmo número
  const pulse = (await call(A, "GET", "/api/pulse/summary")).json.data;
  assert.equal(pulse.kpis.find((k: any) => k.key === "svc").value, pts.svc.value);

  for (const s of ["leverage", "consensus", "roles"]) {
    const r = await call(A, "POST", `${J}/${id}/steps/${s}/complete`, { notes: `ok ${s}` });
    assert.equal(r.status, 200);
  }
  assert.equal((await call(A, "POST", `${J}/${id}/steps/leverage/complete`, {})).json.error, "step_already_done");
  const conv = await call(A, "POST", `${J}/${id}/conviction`);
  assert.equal(conv.status, 200);
  assert.equal(conv.json.data.status, "conviction");
  assert.equal(conv.json.data.convictionRef, `${A.tenantId}/${code}-conviction`);
  assert.ok(existsSync(path.join(dir, `${conv.json.data.convictionRef}.json`)) && existsSync(path.join(dir, `${conv.json.data.convictionRef}.md`)));
  assert.equal((await call(A, "POST", `${J}/${id}/snapshot`)).json.error, "journey_invalid_status");
  assert.equal((await call(A, "POST", `${J}/${id}/conviction`)).json.error, "journey_invalid_status");

  const env1 = (await call(A, "GET", `${J}/${id}/conviction`)).json.data;
  assert.equal(env1.pack.kind, "journey_conviction_pack");
  assert.equal(env1.pack.snapshot.leverage.points.find((k: any) => k.key === "svc").value, 0.9);
  assert.deepEqual(env1.pack, JSON.parse(readFileSync(path.join(dir, `${env1.ref}.json`), "utf8")));
  const mdRes = await call(A, "GET", `${J}/${id}/conviction?format=md`);
  assert.match(mdRes.headers.get("content-type") ?? "", /text\/markdown/);
  assert.match(mdRes.headers.get("content-disposition") ?? "", new RegExp(`attachment; filename="?${code}-conviction\\.md"?`));
  assert.match(mdRes.text, /OTIF \| 90%/);
  assert.match(mdRes.text, /mediana (1,99|2|2,0\d) h/);
  assert.match(mdRes.text, /nota: ok leverage/);
  const jsRes = await call(A, "GET", `${J}/${id}/conviction?format=json`);
  assert.match(jsRes.headers.get("content-disposition") ?? "", /\.json"?$/);
  assert.equal((await call(A, "GET", `${J}/${id}/conviction?format=pdf`)).status, 400);

  assert.deepEqual((await call(A, "POST", `${J}/${id}/land`, {})).json.details?.missing, ["conviction"]);
  assert.equal((await call(A, "POST", `${J}/${id}/steps/conviction/complete`, { notes: "sponsor de acordo" })).status, 200);
  const land = await call(A, "POST", `${J}/${id}/land`, {});
  assert.equal(land.status, 201, JSON.stringify(land.json));
  const L = land.json.data.land;
  assert.equal(L.mode, "created");
  assert.equal(L.slug, `land-${code.toLowerCase()}`);
  assert.equal(L.pack, "generic");
  assert.equal(L.alcada.action, "created");
  assert.deepEqual([land.json.data.run.status, land.json.data.run.landTenantId], ["landed", L.tenantId]);
  // tenant thin: tenant + admin + settings com pack + POL alçada 2 mi; nenhum dado de execução/plano copiado
  const [t] = await q("SELECT slug FROM tenants WHERE id = $1", [L.tenantId]);
  assert.equal(t.slug, L.slug);
  assert.deepEqual((await q("SELECT role, email FROM users WHERE tenant_id = $1", [L.tenantId])).map((u) => [u.role, u.email]), [["admin", `admin@${L.slug}.local`]]);
  const [st] = await q("SELECT industry_pack FROM tenant_settings WHERE tenant_id = $1", [L.tenantId]);
  assert.equal(st.industry_pack, "generic");
  const pol = await q("SELECT body FROM policies WHERE tenant_id = $1 AND is_current", [L.tenantId]);
  assert.deepEqual(pol.map((p) => p.body.limitMi), [2]);
  for (const tb of ["a4_runs", "decision_events", "scenarios", "nodes", "execution_movements", "journey_runs"]) {
    assert.equal((await q(`SELECT count(*)::int n FROM ${tb} WHERE tenant_id = $1`, [L.tenantId]))[0].n, 0, tb);
  }
  // o novo tenant enxerga o próprio pack pela API (RLS do tenant novo)
  const ts = (await call({ tenantId: L.tenantId, userId: L.adminUserId }, "GET", "/api/tenant-settings")).json.data;
  assert.equal(ts.industry_pack, "generic");
  assert.equal((await call(A, "POST", `${J}/${id}/land`, {})).json.error, "journey_invalid_status");
  const audits = await q("SELECT payload->>'action' a FROM audit_log WHERE tenant_id = $1 AND entity = 'journey_runs' AND entity_id = $2 ORDER BY at", [A.tenantId, id]);
  assert.ok(audits.some((x) => x.a === "land") && audits.some((x) => x.a === "conviction"));
});

test("land: slug colide → 409 land_code_exists (nada criado); landTenantId inexistente → 400; vincula tenant com vínculo (W6) → 200", async () => {
  const { A, B } = await tenants();
  const { id } = await toConviction(A);
  assert.equal((await call(A, "POST", `${J}/${id}/steps/conviction/complete`, {})).status, 200);
  const [bslug] = await q("SELECT slug FROM tenants WHERE id = $1", [B.tenantId]);
  const col = await call(A, "POST", `${J}/${id}/land`, { slug: bslug.slug });
  assert.deepEqual([col.status, col.json.error], [409, "land_code_exists"]);
  assert.equal((await call(A, "GET", `${J}/${id}`)).json.data.status, "conviction");
  assert.equal((await call(A, "POST", `${J}/${id}/land`, { landTenantId: B.tenantId, slug: "x-y" })).status, 400);
  const bad = await call(A, "POST", `${J}/${id}/land`, { landTenantId: "00000000-0000-4000-8000-000000000000" });
  assert.deepEqual([bad.status, bad.json.error], [400, "invalid_reference"]);
  assert.equal((await call(A, "POST", `${J}/${id}/land`, { landTenantId: A.tenantId })).json.error, "land_is_lab");
  // W6 (0017): tenant existente sem vínculo ≡ inexistente (400); vínculo = mesmo e-mail do ator admin no alvo
  assert.equal((await call(A, "POST", `${J}/${id}/land`, { landTenantId: B.tenantId })).text, bad.text);
  await q("INSERT INTO users (tenant_id, email, display_name, role) SELECT $1, email, 'Link', 'admin' FROM users WHERE id = $2", [B.tenantId, A.userId]);
  const ok = await call(A, "POST", `${J}/${id}/land`, { landTenantId: B.tenantId });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.json.data.land.mode, ok.json.data.run.status, ok.json.data.run.landTenantId], ["link", "landed", B.tenantId]);
});

test("RLS cross-tenant: B não vê/lista/escreve journey de A; conviction de A invisível para B", async () => {
  const { A, B } = await tenants();
  const { id } = await toConviction(A);
  assert.equal((await call(B, "GET", `${J}/${id}`)).status, 404);
  assert.equal((await call(B, "GET", `${J}/${id}/conviction`)).status, 404);
  assert.equal((await call(B, "POST", `${J}/${id}/steps/conviction/complete`, {})).status, 404);
  assert.equal((await call(B, "POST", `${J}/${id}/land`, {})).status, 404);
  assert.deepEqual((await call(B, "GET", J)).json, { data: [], count: 0 });
  assert.equal((await call(A, "GET", `${J}?status=conviction`)).json.count, 1);
  assert.equal((await call(A, "GET", `${J}?status=open`)).json.count, 0);
  // INSERT com tenant de outro → WITH CHECK recusa
  await assert.rejects(withTenant(pool, B.tenantId, (c) => c.query(
    "INSERT INTO journey_runs (tenant_id, code) VALUES ($1, 'JR-X')", [A.tenantId])), /row-level security/);
});

test("0016 (med Deivid): land fn NÃO depende de BYPASSRLS — dono sem bypass cria tenant+admin; app.tenant_id volta ao lab", async () => {
  const { A } = await tenants();
  const code = `NB-${uniq()}`, slug = `land-nb-${uniq().toLowerCase()}`;
  const [{ id }] = await q("INSERT INTO journey_runs (tenant_id, code, status) VALUES ($1, $2, 'conviction') RETURNING id", [A.tenantId, code]);
  const role = `ibp_land_nobypass_${uniq().toLowerCase()}`;
  // simulação numa transação do owner (ROLLBACK no fim): a função passa a pertencer a uma role NOSUPERUSER NOBYPASSRLS
  // com só os grants que precisa; chamada como ibp_app. Em 0015 (sem set_config do tenant novo) o INSERT em tenants
  // viola o WITH CHECK da FORCE RLS (id = app_tenant_id()).
  await owner.query("BEGIN");
  try {
    await owner.query("SELECT pg_advisory_xact_lock(hashtext('ibp_schema_migrations'))"); // não cruza com migrate em paralelo
    await owner.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await owner.query(`GRANT SELECT, INSERT ON tenants, users TO ${role}`);
    await owner.query(`GRANT SELECT, UPDATE ON journey_runs TO ${role}`);
    await owner.query(`ALTER FUNCTION journey_land_tenant(uuid, text, text) OWNER TO ${role}`);
    await owner.query("SET LOCAL ROLE ibp_app");
    await owner.query("SELECT set_config('app.tenant_id', $1, true)", [A.tenantId]);
    const [r] = (await owner.query("SELECT * FROM journey_land_tenant($1, $2, 'Land NB')", [id, slug])).rows;
    assert.ok(r.tenant_id && r.admin_user_id);
    assert.equal((await owner.query("SELECT current_setting('app.tenant_id') t")).rows[0].t, A.tenantId, "fn restaura app.tenant_id do lab");
    await owner.query("RESET ROLE");
    const [u] = (await owner.query("SELECT u.tenant_id, u.role, t.slug FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1", [r.admin_user_id])).rows;
    assert.deepEqual([u.tenant_id, u.role, u.slug], [r.tenant_id, "admin", slug]);
  } finally {
    await owner.query("ROLLBACK");
  }
  assert.equal((await q("SELECT 1 FROM tenants WHERE slug = $1", [slug])).length, 0, "rollback: nada vaza");
});

test("0016: chamada real (owner do schema) também restaura app.tenant_id do lab na mesma transação", async () => {
  const { A } = await tenants();
  const slug = `land-rs-${uniq().toLowerCase()}`;
  const [{ id }] = await q("INSERT INTO journey_runs (tenant_id, code, status) VALUES ($1, $2, 'conviction') RETURNING id", [A.tenantId, `RS-${uniq()}`]);
  const after = await withTenant(pool, A.tenantId, async (c) => {
    await c.query("SELECT * FROM journey_land_tenant($1, $2, 'Land RS')", [id, slug]);
    return (await c.query("SELECT current_setting('app.tenant_id') t")).rows[0].t as string;
  });
  assert.equal(after, A.tenantId);
  const [fn] = await q("SELECT prosrc FROM pg_proc WHERE proname = 'journey_land_tenant'");
  const s = fn.prosrc as string;
  assert.ok(s.indexOf("set_config('app.tenant_id', v_t::text, true)") > -1 &&
    s.indexOf("set_config('app.tenant_id', v_t::text, true)") < s.indexOf("INSERT INTO tenants"), "tenant novo setado antes dos INSERTs");
});
