/**
 * seed:dom-fixture — T-DOM-ENG-WRITE (PO cravos seed yes/yes/yes, 2026-10-31) · checklist docs/architecture/DOM-CADASTRO-WRITE-SEED-CHECKLIST.md §4.
 *   S0 pré-flight (GET) · S1 tenant + users (owner: admin/domain_owner/finance/sales @qa-dom.local) · S2 fixture E1 PELA API
 *   (mesmo write path do produto: zod + RLS + audit `why`; nunca SQL direto em cadastro) · S3 verificação + TENANT_ID/USER_ID por papel.
 * Idempotente: S1 por slug/email (ON CONFLICT); S2 por business key (GET lista → corrente existe → skip; pack igual → skip;
 *   confirmed só se confirmed_at null). 2ª execução no mesmo slug = zero versão nova.
 * Guardas: só slug `qa-dom-*`; recusa o empty-tenant de referência E0 (e5cf…) por id; nunca escreve fora do tenant do slug.
 * Fica fora de src/ de propósito: é um CLIENTE HTTP da API (fetch) — o backend continua sem fetch( (npm run gate, regra 4).
 *
 * Uso (local):  npm run seed:dom-fixture -- qa-dom-20261031-1 [--api http://localhost:3000] [--pack generic] [--no-provision] [--dry-run]
 *   --users-only = só S1 (tenant vazio E0-like + 4 users; p/ happy path manual pela UI a partir do zero).
 *   S1 usa MIGRATION_DATABASE_URL (.env). Com --no-provision o slug já tem que existir (só S0/S2/S3 + lookup dos users).
 * Prod (Neon): só com autorização explícita do PO/Deivid (G5 claim) — rodar com MIGRATION_DATABASE_URL do Neon e --api https://ibp-agentic.vercel.app.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { env } from "../src/config/env.js";

const E0_TENANT = "e5cf5324-7a2b-4e95-80c8-fd119b7bede7"; // empty-tenant de referência (smoke Embed) — congelado (cravo 1)
const SLUG_RE = /^qa-dom-[a-z0-9][a-z0-9-]{0,60}$/;
const WHY = "seed:dom-fixture (T-DOM-ENG-WRITE · checklist §4)";
const ROLES = ["admin", "domain_owner", "finance", "sales"] as const;
type Role = (typeof ROLES)[number];

function args() {
  const a = process.argv.slice(2);
  const opt = (k: string, d: string) => { const i = a.indexOf(k); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  const slug = a.find((x, i) => !x.startsWith("--") && !["--api", "--pack"].includes(a[i - 1] ?? "")) ?? process.env.QA_DOM_SLUG ?? "";
  return {
    slug, api: opt("--api", process.env.API_BASE ?? "http://localhost:3000").replace(/\/$/, ""),
    pack: opt("--pack", "generic"), provision: !a.includes("--no-provision"), dry: a.includes("--dry-run"), usersOnly: a.includes("--users-only"),
  };
}

/* ---------- S1 · owner: tenant + 4 users (idempotente) ---------- */
async function provision(slug: string, dry: boolean): Promise<{ tenantId: string; users: Record<Role, string> }> {
  const c = new pg.Client({ connectionString: env.migrationDatabaseUrl });
  await c.connect();
  try {
    const found = (await c.query("SELECT id FROM tenants WHERE slug = $1", [slug])).rows[0];
    if (found?.id === E0_TENANT) throw new Error("refuse: slug resolves to E0 empty reference tenant");
    if (dry) {
      if (!found) return { tenantId: "(would create)", users: {} as Record<Role, string> };
      const us = (await c.query("SELECT role, id FROM users WHERE tenant_id = $1 AND email LIKE '%@qa-dom.local'", [found.id])).rows;
      return { tenantId: found.id, users: Object.fromEntries(us.map((u) => [u.role, u.id])) as Record<Role, string> };
    }
    const tenantId: string = found?.id ?? randomUUID();
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await c.query("INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING", [tenantId, slug, `QA Dom ${slug}`]);
    const users = {} as Record<Role, string>;
    for (const role of ROLES) {
      const u = await c.query(
        `INSERT INTO users (tenant_id, email, display_name, role) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, email) DO UPDATE SET role = EXCLUDED.role RETURNING id`,
        [tenantId, `${role.replace("_", "-")}@qa-dom.local`, `QA ${role}`, role]);
      users[role] = u.rows[0].id;
    }
    await c.query("INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", [tenantId]);
    await c.query("COMMIT");
    return { tenantId, users };
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { await c.end(); }
}

async function lookup(slug: string) { // --no-provision: só leitura via owner (tenants/users não são legíveis por slug via API)
  const c = new pg.Client({ connectionString: env.migrationDatabaseUrl });
  await c.connect();
  try {
    const t = (await c.query("SELECT id FROM tenants WHERE slug = $1", [slug])).rows[0];
    if (!t) throw new Error(`tenant_not_found: ${slug} (rode sem --no-provision)`);
    const us = (await c.query("SELECT role, id FROM users WHERE tenant_id = $1 AND email LIKE '%@qa-dom.local'", [t.id])).rows;
    return { tenantId: t.id as string, users: Object.fromEntries(us.map((u) => [u.role, u.id])) as Record<Role, string> };
  } finally { await c.end(); }
}

/* ---------- HTTP client (headers seed; nunca ignora erro) ---------- */
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
function client(api: string, tenantId: string, userId: string, dry: boolean) {
  const log: string[] = [];
  async function call(method: string, path: string, body?: unknown): Promise<Json> {
    if (dry && method !== "GET") { log.push(`DRY ${method} ${path} ${JSON.stringify(body)}`); return { data: null, dry: true }; }
    const r = await fetch(api + path, {
      method, headers: { "content-type": "application/json", "x-tenant-id": tenantId, "x-user-id": userId },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const txt = await r.text(); let j: Json = null; try { j = txt ? JSON.parse(txt) : null; } catch { j = { raw: txt.slice(0, 300) }; }
    if (method !== "GET") log.push(`${method} ${path} → ${r.status}`);
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
    return j;
  }
  return { call, log };
}

async function main() {
  const o = args();
  if (!SLUG_RE.test(o.slug)) throw new Error(`refuse: slug must match ${SLUG_RE} (got "${o.slug}") — E0/prod tenants are never seeded`);

  // S1
  const p = o.provision ? await provision(o.slug, o.dry) : await lookup(o.slug);
  if (p.tenantId === E0_TENANT) throw new Error("refuse: E0");
  const admin = p.users.admin;
  if (!admin) { console.log(JSON.stringify({ step: "S1", dry: o.dry, ...p })); if (o.dry) return; throw new Error("no admin user"); }
  if (o.usersOnly) {
    console.log(`S1 only (tenant vazio)\nSLUG=${o.slug}\nTENANT_ID=${p.tenantId}`);
    for (const r of ROLES) console.log(`USER_ID_${r.toUpperCase()}=${p.users[r] ?? "(missing)"}`);
    return;
  }
  const { call, log } = client(o.api, p.tenantId, admin, o.dry);

  // S0 (read-only)
  const health = await fetch(o.api + "/health").then((r) => r.status);
  const me = (await call("GET", "/api/me")).data ?? null;
  const rd0 = (await call("GET", "/api/a4-readiness")).data;
  console.log(`S0 health=${health} me.role=${me?.role} readiness=${rd0?.state} ${rd0?.met}/${rd0?.need}`);

  // S2 — fixture E1 via API
  let st = (await call("GET", "/api/tenant-settings")).data;
  if (st.industry_pack !== o.pack) {
    await call("POST", "/api/cadastro/pack", { pack: o.pack, why: WHY });
    st = o.dry ? st : (await call("GET", "/api/tenant-settings")).data;
  }
  const types: string[] = Array.isArray(st.node_types) && st.node_types.length ? st.node_types : ["CD", "Filial"];
  const list = async (path: string) => ((await call("GET", `/api/${path}`)).data ?? []).filter((r: Json) => r.is_current !== false);
  const ensure = async (path: string, match: (r: Json) => boolean, body: Json) => {
    const hit = (await list(path)).find(match);
    if (hit) return hit;
    const r = await call("POST", `/api/${path}`, { ...body, why: WHY });
    return r.data ?? { stable_id: `(dry:${path})` };
  };
  const n1 = await ensure("nodes", (r) => r.code === "QA-CD-01", { code: "QA-CD-01", name: "QA CD 01", node_type: types[0] });
  const n2 = await ensure("nodes", (r) => r.code === "QA-FIL-01", { code: "QA-FIL-01", name: "QA Filial 01", node_type: types[1] ?? types[0] });
  await ensure("node_capacity", (r) => r.node_id === n1.stable_id, { node_id: n1.stable_id, capacity_per_period: 1000 });
  await ensure("skus", (r) => r.code === "QA-SKU-01", { code: "QA-SKU-01", name: "QA SKU 01", family: "QA", unit_cost: 10 });
  await ensure("routes", (r) => r.code === "QA-RT-01",
    { code: "QA-RT-01", origin_node_id: n1.stable_id, dest_node_id: n2.stable_id, mode: "rodoviário", lead_time_days: 2, cost_per_unit: 1.5 });
  const wcKind = (st.policy_kinds_effective?.working_capital?.[0] as string | undefined) ?? "working_capital";
  await ensure("policies", (r) => r.kind === wcKind && r.name === "QA capital de giro",
    { kind: wcKind, name: "QA capital de giro", body: { tipo: "Capital de giro", escopo: "Rede", metrica: "DSI (dias)", valor: "≤ 45", acao: "alertar", dono: "Finance" } });
  if (!st.confirmed_at && !o.dry) {
    const s = (await call("GET", "/api/tenant-settings")).data;
    if (!s.confirmed_at) await call("PUT", "/api/tenant-settings", { confirmed: true });
  }

  // S3
  const rd = (await call("GET", "/api/a4-readiness")).data;
  const q = (await call("GET", "/api/alcada/queue")) ?? {}; // mode/policy no topo (data = fila)
  const s3 = (await call("GET", "/api/tenant-settings")).data;
  const lim = q.limitMi ?? q.policy?.limitMi ?? q.policy?.alcadaMi ?? null;
  const ok = o.dry || (rd?.unlock?.new_scenario === true && ["ok", "warn"].includes(rd?.state) && q.mode === "active" && s3.industry_pack === o.pack);
  console.log(`S2 writes: ${log.length ? "\n  " + log.join("\n  ") : "none (idempotent: all present)"}`);
  console.log(`S3 readiness=${rd?.state} ${rd?.met}/${rd?.need} new_scenario=${rd?.unlock?.new_scenario} alcada=${q.mode} limitMi=${lim} pack=${s3.industry_pack} confirmed_at=${s3.confirmed_at ?? null}`);
  console.log(`SLUG=${o.slug}\nTENANT_ID=${p.tenantId}`);
  for (const r of ROLES) console.log(`USER_ID_${r.toUpperCase()}=${p.users[r] ?? "(missing)"}`);
  console.log(`SMOKE ${o.api}/?live=1&tenant_id=${p.tenantId}  (localStorage ibp.live.userId=${admin})`);
  if (!ok) { console.error("seed:dom-fixture S3 FAILED"); process.exit(2); }
  console.log(o.dry ? "seed:dom-fixture DRY-RUN OK" : "seed:dom-fixture OK");
}

main().catch((e) => { console.error("seed:dom-fixture ERROR:", e instanceof Error ? e.message : e); process.exit(1); });
