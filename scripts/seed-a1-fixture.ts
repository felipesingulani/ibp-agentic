/**
 * seed:a1-fixture — T-A1-ENG (A1-CURVA-DEMANDA-CONTRACT.md §9 · QA-ACCEPTANCE-A1-CURVA.md D4).
 *   S1 tenant + admin (owner, idempotente) · S2 E1 mínimo PELA API (desbloqueia cenário) + nós âncora com hist
 *   12 / 5 / 0 meses (QA-A1-ANC12 / QA-A1-ANC05 / QA-A1-ANC00) + nó alvo QA-A1-FIL-ALVO · S3 cenário "QA A1 curva" + ids p/ Qualidade.
 * Escrita em sales_history aqui é FIXTURE via POST /api/sales_history (ingest do produto); A1 em si nunca escreve hist.
 * Guardas: só slug `qa-a1-*`; recusa E0 (e5cf…) por id; nunca escreve fora do tenant do slug. Idempotente por business key.
 * Fica fora de src/ (cliente HTTP com fetch — backend sem fetch(, gate regra 4).
 *
 * Uso (local):  npm run seed:a1-fixture -- qa-a1-20261031-1 [--api http://localhost:3000] [--dry-run]
 * Prod (Neon): só com autorização explícita PO/Deivid — MIGRATION_DATABASE_URL do Neon + --api https://ibp-agentic.vercel.app.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { env } from "../src/config/env.js";

const E0_TENANT = "e5cf5324-7a2b-4e95-80c8-fd119b7bede7";
const SLUG_RE = /^qa-a1-[a-z0-9][a-z0-9-]{0,60}$/;
const WHY = "seed:a1-fixture (T-A1-ENG · contrato A1 §9)";
const ANCHORS = [["QA-A1-ANC12", 12], ["QA-A1-ANC05", 5], ["QA-A1-ANC00", 0]] as const;
const HIST_TO = "2026-09"; // último mês fechado (fixture determinística)
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function args() {
  const a = process.argv.slice(2);
  const opt = (k: string, d: string) => { const i = a.indexOf(k); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  const slug = a.find((x, i) => !x.startsWith("--") && a[i - 1] !== "--api") ?? process.env.QA_A1_SLUG ?? "";
  return { slug, api: opt("--api", process.env.API_BASE ?? "http://localhost:3000").replace(/\/$/, ""), dry: a.includes("--dry-run") };
}
export function monthsBack(n: number, to = HIST_TO): string[] { // ascendente, terminando em `to`
  const [y, m] = to.split("-").map(Number); const t = y * 12 + m - 1;
  return Array.from({ length: n }, (_, i) => { const k = t - (n - 1 - i); return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`; });
}

async function provision(slug: string, dry: boolean): Promise<{ tenantId: string; adminId: string | null }> {
  const c = new pg.Client({ connectionString: env.migrationDatabaseUrl });
  await c.connect();
  try {
    const found = (await c.query("SELECT id FROM tenants WHERE slug = $1", [slug])).rows[0];
    if (found?.id === E0_TENANT) throw new Error("refuse: slug resolves to E0 empty reference tenant");
    if (dry) {
      if (!found) return { tenantId: "(would create)", adminId: null };
      const u = (await c.query("SELECT id FROM users WHERE tenant_id = $1 AND email = 'admin@qa-a1.local'", [found.id])).rows[0];
      return { tenantId: found.id, adminId: u?.id ?? null };
    }
    const tenantId: string = found?.id ?? randomUUID();
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await c.query("INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING", [tenantId, slug, `QA A1 ${slug}`]);
    const u = await c.query(
      `INSERT INTO users (tenant_id, email, display_name, role) VALUES ($1, 'admin@qa-a1.local', 'QA A1 admin', 'admin')
       ON CONFLICT (tenant_id, email) DO UPDATE SET role = EXCLUDED.role RETURNING id`, [tenantId]);
    await c.query("INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", [tenantId]);
    await c.query("COMMIT");
    return { tenantId, adminId: u.rows[0].id };
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { await c.end(); }
}

function client(api: string, tenantId: string, userId: string, dry: boolean) {
  const log: string[] = [];
  async function call(method: string, path: string, body?: unknown): Promise<Json> {
    if (dry && method !== "GET") { log.push(`DRY ${method} ${path}`); return { data: null, dry: true }; }
    const r = await fetch(api + path, { method, headers: { "content-type": "application/json", "x-tenant-id": tenantId, "x-user-id": userId },
      body: body === undefined ? undefined : JSON.stringify(body) });
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
  const p = await provision(o.slug, o.dry);
  if (p.tenantId === E0_TENANT) throw new Error("refuse: E0");
  if (!p.adminId) { console.log(JSON.stringify({ step: "S1", dry: o.dry, ...p })); return; }
  const { call, log } = client(o.api, p.tenantId, p.adminId, o.dry);

  // S2 — E1 mínimo (mesmo do seed:dom-fixture) p/ desbloquear cenário + âncoras A1
  let st = (await call("GET", "/api/tenant-settings")).data;
  if (st.industry_pack !== "generic") { await call("POST", "/api/cadastro/pack", { pack: "generic", why: WHY }); st = o.dry ? st : (await call("GET", "/api/tenant-settings")).data; }
  const types: string[] = Array.isArray(st.node_types) && st.node_types.length ? st.node_types : ["CD", "Filial"];
  const fil = types[1] ?? types[0];
  const list = async (path: string) => ((await call("GET", `/api/${path}`)).data ?? []).filter((r: Json) => r.is_current !== false);
  const ensure = async (path: string, match: (r: Json) => boolean, body: Json) => {
    const hit = (await list(path)).find(match);
    if (hit) return hit;
    return (await call("POST", `/api/${path}`, { ...body, why: WHY })).data ?? { stable_id: `(dry:${path}:${body.code ?? ""})` };
  };
  const cd = await ensure("nodes", (r) => r.code === "QA-A1-CD", { code: "QA-A1-CD", name: "QA A1 CD", node_type: types[0] });
  const alvo = await ensure("nodes", (r) => r.code === "QA-A1-FIL-ALVO", { code: "QA-A1-FIL-ALVO", name: "QA A1 Filial alvo", node_type: fil });
  const anchors: Record<string, Json> = {};
  for (const [code] of ANCHORS) anchors[code] = await ensure("nodes", (r) => r.code === code, { code, name: code, node_type: fil });
  await ensure("node_capacity", (r) => r.node_id === cd.stable_id, { node_id: cd.stable_id, capacity_per_period: 5000 });
  const sku = await ensure("skus", (r) => r.code === "QA-A1-SKU", { code: "QA-A1-SKU", name: "QA A1 SKU", family: "QA", unit_cost: 10 });
  await ensure("routes", (r) => r.code === "QA-A1-RT", { code: "QA-A1-RT", origin_node_id: cd.stable_id, dest_node_id: alvo.stable_id,
    mode: "rodoviário", lead_time_days: 2, cost_per_unit: 1.5 });
  const wcKind = (st.policy_kinds_effective?.working_capital?.[0] as string | undefined) ?? "working_capital";
  await ensure("policies", (r) => r.kind === wcKind && r.name === "QA A1 capital de giro",
    { kind: wcKind, name: "QA A1 capital de giro", body: { tipo: "Capital de giro", escopo: "Rede", metrica: "DSI (dias)", valor: "≤ 45", acao: "alertar", dono: "Finance" } });
  if (!o.dry && !(await call("GET", "/api/tenant-settings")).data.confirmed_at) await call("PUT", "/api/tenant-settings", { confirmed: true });

  // hist: ANC12 = 12 meses (rampa 100..210), ANC05 = 5 meses (80), ANC00 = 0. Idempotente por (node, sku, period).
  const have = new Set(((await call("GET", "/api/sales_history")).data ?? []).map((r: Json) => `${r.node_id}|${r.sku_id}|${r.period}`));
  const rows: Json[] = [];
  for (const [code, n] of ANCHORS) monthsBack(n).forEach((period, i) => {
    const row = { node_id: anchors[code].stable_id, sku_id: sku.stable_id, period, qty: code === "QA-A1-ANC12" ? 100 + i * 10 : 80 };
    if (!have.has(`${row.node_id}|${row.sku_id}|${period}`)) rows.push(row);
  });
  if (rows.length) await call("POST", "/api/sales_history", { rows, why: WHY });

  // S3 — cenário (W2 unlock) p/ ditado
  const scns = ((await call("GET", "/api/scenarios")).data ?? []) as Json[];
  const scn = scns.find((s) => s.name === "QA A1 curva") ?? (await call("POST", "/api/scenarios", { name: "QA A1 curva" })).data;
  const hist = o.dry ? [] : ((await call("GET", "/api/sales_history")).data ?? []) as Json[];
  const per = Object.fromEntries(ANCHORS.map(([code]) => [code, new Set(hist.filter((r) => r.node_id === anchors[code].stable_id).map((r) => String(r.period).slice(0, 7))).size]));
  console.log(`S2 writes: ${log.length ? "\n  " + log.join("\n  ") : "none (idempotent: all present)"}`);
  console.log(`S3 hist meses ${JSON.stringify(per)} (esperado ANC12=12 ANC05=5 ANC00=0)`);
  console.log(`SLUG=${o.slug}\nTENANT_ID=${p.tenantId}\nUSER_ID_ADMIN=${p.adminId}\nSCENARIO_ID=${scn?.id ?? "(dry)"}\nSKU=${sku.stable_id}\nALVO=${alvo.stable_id}`);
  for (const [code] of ANCHORS) console.log(`${code}=${anchors[code].stable_id}`);
  const ok = o.dry || (per["QA-A1-ANC12"] === 12 && per["QA-A1-ANC05"] === 5 && per["QA-A1-ANC00"] === 0 && !!scn?.id);
  if (!ok) { console.error("seed:a1-fixture S3 FAILED"); process.exit(2); }
  console.log(o.dry ? "seed:a1-fixture DRY-RUN OK" : "seed:a1-fixture OK");
}

main().catch((e) => { console.error("seed:a1-fixture ERROR:", e instanceof Error ? e.message : e); process.exit(1); });
