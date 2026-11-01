import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { type Client, type Pool, withTenant } from "../db/pool.js";
import {
  AliasConflict, type EntityDef, YM_RE, aliasIn, aliasOut, apiFields, entities, entityByPath, jsonColumns,
} from "../domain/entities.js";
import { computeReadiness, loadReadinessFacts } from "../domain/a4Readiness.js";
import { type PolicyKindWarning, effectivePolicyKinds, policyKindWarnings } from "../domain/policy-kinds.js";
import { a4RunsRouter } from "./a4-runs.js";
import { decisionEventsRouter } from "./decision-events.js";
import { a7Router } from "./a7.js";
import { alcadaRouter } from "./alcada.js";
import { pulseRouter } from "./pulse.js";
import { visoesRouter } from "./visoes.js";
import { executionRouter } from "./execution.js";
import { journeyRouter } from "./journey.js";
import { plansRouter } from "./plans.js";
import { mountWizard } from "./scenarios.js";
import type { DitadoLlm } from "../wizard/ditado.js";
import { type Ctx, type Row, assertCurrentRefs, audit, ctxOf, requireUser, uuidRe, whySchema } from "./common.js";
import { HttpError, errorHandler } from "./errors.js";
import { premiseCardsRouter } from "./premise-cards.js";
import { uiRouter } from "./ui.js";
import { mountCadastro } from "./cadastro.js";
import { beforePolicyCreate, beforePolicyPatch, beforePolicyRetire } from "../cadastro/alcada-write.js";

// ─── auth stub ────────────────────────────────────────────────
// W0: tenant/usuário vêm de headers (stub). Auth real (Clerk/Auth.js/Supabase) entra depois e preenche o mesmo Ctx.
async function resolveCtx(pool: Pool, req: Request): Promise<Ctx> {
  const tenantId = req.header("x-tenant-id") ?? "";
  if (!uuidRe.test(tenantId)) throw new HttpError(401, "missing_or_invalid_x-tenant-id");
  const userId = req.header("x-user-id") ?? null;
  if (userId !== null && !uuidRe.test(userId)) throw new HttpError(401, "invalid_x-user-id");
  return withTenant(pool, tenantId, async (c) => {
    const t = await c.query("SELECT id FROM tenants WHERE id = $1", [tenantId]); // RLS: só o próprio tenant
    if (!t.rowCount) throw new HttpError(401, "unknown_tenant");
    let role: string | null = null;
    if (userId) {
      const u = await c.query("SELECT role FROM users WHERE id = $1", [userId]);
      if (!u.rowCount) throw new HttpError(401, "unknown_user");
      role = u.rows[0].role;
    }
    return { tenantId, userId, role };
  });
}

/** W6 · Task 12: kind da policy (versão gravada) fora do vocabulário do tenant → warnings no corpo (status inalterado). */
async function policyWarnings(c: Client, row: Row): Promise<PolicyKindWarning[]> {
  const raw = (await c.query("SELECT policy_kinds FROM tenant_settings")).rows[0]?.policy_kinds ?? {};
  return policyKindWarnings(effectivePolicyKinds(raw), String(row.kind ?? ""));
}

function toParams(cols: string[], data: Row): unknown[] {
  return cols.map((k) => (jsonColumns.has(k) && data[k] !== undefined ? JSON.stringify(data[k]) : data[k]));
}

async function insertRow(c: Client, def: EntityDef, data: Row): Promise<Row> {
  const cols = Object.keys(data).filter((k) => data[k] !== undefined);
  const vals = toParams(cols, data);
  const ph = cols.map((_, i) => `$${i + 1}`);
  // nomes de coluna vêm do whitelist do registry (zod schema) + colunas fixas — nunca do usuário
  const r = await c.query(`INSERT INTO ${def.table} (${cols.join(", ")}) VALUES (${ph.join(", ")}) RETURNING *`, vals);
  return r.rows[0];
}

/** Referências de cadastro → stable_id corrente (ver assertCurrentRefs). */
async function checkRefs(c: Client, def: EntityDef, data: Row) {
  for (const ref of def.refs ?? []) {
    const v = data[ref.field];
    if (v === undefined || v === null) continue;
    await assertCurrentRefs(c, ref.table, ref.field, ref.many ? (v as string[]) : [v as string]);
  }
}

/** node_type: se tenant_settings.node_types não está vazio, o valor tem que estar na lista; vazio = qualquer texto não vazio. */
async function checkVocab(c: Client, def: EntityDef, data: Row) {
  if (def.table !== "nodes" || data.node_type === undefined) return;
  const types: string[] = (await c.query("SELECT node_types FROM tenant_settings")).rows[0]?.node_types ?? [];
  if (types.length && !types.includes(String(data.node_type))) {
    throw new HttpError(400, "invalid_node_type", { allowed: types, source: "tenant_settings.node_types" });
  }
}

function fromApi(def: EntityDef, body: Row): Row {
  try { return aliasIn(def, body); } catch (e) {
    if (e instanceof AliasConflict) throw new HttpError(400, "alias_conflict", { alias: e.alias, column: e.column });
    throw e;
  }
}

function keyWhere(def: EntityDef, row: Row, offset = 0) {
  const where = def.businessKey.map((k, i) => `${k} = $${i + 1 + offset}`);
  return { sql: where.length ? where.join(" AND ") : "TRUE", params: def.businessKey.map((k) => row[k]) };
}

// ─── generic cadastro router ──────────────────────────────────
function entityRouter(pool: Pool, def: EntityDef) {
  const r = express.Router();
  const tx = <T>(res: Response, fn: (c: Client, ctx: Ctx) => Promise<T>) =>
    withTenant(pool, ctxOf(res).tenantId, (c) => fn(c, ctxOf(res)));
  const writable = Object.keys(def.schema.shape);
  const out = (row: Row) => aliasOut(def, row);

  r.get("/", async (req, res) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (def.versioned && req.query.include_history !== "true") where.push("is_current");
    for (const f of ["node_id", "sku_id", "kind", "code", "stable_id"]) {
      const v = req.query[f];
      const ok = writable.includes(f) || (f === "stable_id" && def.versioned);
      if (typeof v === "string" && ok) {
        if (f.endsWith("_id") && !uuidRe.test(v)) throw new HttpError(400, "invalid_input", { field: f });
        params.push(v); where.push(`${f} = $${params.length}`);
      }
    }
    if (def.path === "sales_history") {
      // T-DM-PERIOD-GRAIN: filtro só mês YYYY-MM (comparação lexicográfica ≡ cronológica nesse formato)
      for (const [q, op] of [["period_from", ">="], ["period_to", "<="]] as const) {
        const v = req.query[q];
        if (typeof v !== "string") continue;
        if (!YM_RE.test(v)) throw new HttpError(400, "validation_failed", [{ path: [q], message: "YYYY-MM (só mês)" }]);
        params.push(v); where.push(`period ${op} $${params.length}`);
      }
    }
    const limit = Math.min(Number(req.query.limit ?? 500) || 500, 5000);
    const rows = await tx(res, (c) => c.query(
      `SELECT * FROM ${def.table} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${def.orderBy} LIMIT ${limit}`,
      params).then((q) => q.rows));
    res.json({ data: rows.map(out), count: rows.length });
  });

  r.get("/:id", async (req, res) => {
    if (!uuidRe.test(req.params.id)) throw new HttpError(404, "not_found");
    const row = await tx(res, (c) => c.query(`SELECT * FROM ${def.table} WHERE id = $1`, [req.params.id]).then((q) => q.rows[0]));
    if (!row) throw new HttpError(404, "not_found");
    res.json({ data: out(row) });
  });

  if (def.versioned) {
    r.get("/:id/history", async (req, res) => {
      if (!uuidRe.test(req.params.id)) throw new HttpError(404, "not_found");
      const rows = await tx(res, async (c) => {
        const row = (await c.query(`SELECT * FROM ${def.table} WHERE id = $1 OR stable_id = $1 LIMIT 1`, [req.params.id])).rows[0];
        if (!row) throw new HttpError(404, "not_found");
        // :id aceita id de qualquer versão ou o stable_id; histórico = todas as versões da identidade
        return (await c.query(`SELECT * FROM ${def.table} WHERE stable_id = $1 ORDER BY version`, [row.stable_id])).rows;
      });
      res.json({ data: rows.map(out) });
    });
  }

  r.post("/", async (req, res) => {
    const ctx = ctxOf(res);
    requireUser(ctx);
    const body = (req.body ?? {}) as Row;
    if (!def.versioned) {
      // sales_history: ingest de 1 linha ou { rows: [...] }
      const list = Array.isArray(body.rows) ? body.rows : [body];
      if (list.length > 5000) throw new HttpError(413, "max 5000 rows per ingest");
      const parsed = list.map((x) => def.schema.parse(x));
      const out = await tx(res, async (c) => {
        const inserted: Row[] = [];
        for (const p of parsed) {
          await checkRefs(c, def, p);
          inserted.push(await insertRow(c, def, { ...p, tenant_id: ctx.tenantId }));
        }
        await audit(c, ctx, "ingest", def.table, inserted.length === 1 ? String(inserted[0].id) : "*",
          { rows: inserted.length, why: typeof body.why === "string" ? body.why : null });
        return inserted;
      });
      return res.status(201).json(Array.isArray(body.rows) ? { data: out, count: out.length } : { data: out[0] });
    }
    const data = def.schema.parse(fromApi(def, body)) as Row;
    const { row, packSwitched, warnings } = await tx(res, async (c) => {
      // W3b: regra de alçada (hook único src/cadastro/alcada-write.ts) — 409 alcada_exists / switch p/ generic
      const packSwitched = def.table === "policies"
        ? await beforePolicyCreate(c, ctx, data, typeof body.why === "string" ? body.why : null) : null;
      await checkRefs(c, def, data);
      await checkVocab(c, def, data);
      const k = keyWhere(def, data);
      const dup = await c.query(`SELECT id FROM ${def.table} WHERE ${k.sql} LIMIT 1`, k.params);
      if (dup.rowCount) throw new HttpError(409, "already_exists — use PATCH /:id (nova versão)", { id: dup.rows[0].id });
      const sid = randomUUID(); // v1: id = stable_id; versões seguintes herdam stable_id
      const ins = await insertRow(c, def, {
        ...data, id: sid, stable_id: sid, tenant_id: ctx.tenantId, version: 1, is_current: true,
        ...(def.hasCreatedBy ? { created_by: ctx.userId } : {}),
      });
      await audit(c, ctx, "create", def.table, String(ins.id),
        { version: 1, why: typeof body.why === "string" ? body.why : null, data });
      const warnings = def.table === "policies" ? await policyWarnings(c, ins) : [];
      return { row: ins, packSwitched, warnings };
    });
    res.status(201).json({ data: out(row), ...(packSwitched ? { packSwitched } : {}), ...(warnings.length ? { warnings } : {}) });
  });

  if (def.versioned) {
    // Update = nova versão (linha nova, version+1, is_current); anterior vira is_current=false. `why` obrigatório.
    r.patch("/:id", async (req, res) => {
      const ctx = ctxOf(res);
      requireUser(ctx);
      if (!uuidRe.test(req.params.id)) throw new HttpError(404, "not_found");
      const { why } = whySchema.parse(req.body ?? {});
      const { why: _w, ...rest } = (req.body ?? {}) as Row;
      const patch = def.schema.partial().strict().parse(fromApi(def, rest)) as Row;
      if (!Object.keys(patch).length) throw new HttpError(400, "empty_patch");
      for (const k of def.businessKey) if (k in patch) throw new HttpError(400, `business key '${k}' is immutable; create a new record`);
      const row = await tx(res, async (c) => {
        const prev = (await c.query(`SELECT * FROM ${def.table} WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
        if (!prev) throw new HttpError(404, "not_found");
        if (!prev.is_current) throw new HttpError(409, "not_current_version");
        if (def.table === "policies") await beforePolicyPatch(c, ctx, prev, patch); // W3b: limitMi estrito
        await checkRefs(c, def, patch);
        await checkVocab(c, def, patch);
        const merged: Row = {};
        for (const k of writable) merged[k] = k in patch ? patch[k] : prev[k];
        await c.query(`UPDATE ${def.table} SET is_current = false WHERE id = $1`, [prev.id]);
        const ins = await insertRow(c, def, {
          ...merged, stable_id: prev.stable_id, tenant_id: ctx.tenantId, version: Number(prev.version) + 1, is_current: true,
          ...(def.hasCreatedBy ? { created_by: ctx.userId } : {}),
        });
        await audit(c, ctx, "update", def.table, String(ins.id),
          { why, stable_id: prev.stable_id, previous_id: prev.id, previous_version: prev.version, version: ins.version, changes: patch });
        return { ins, warnings: def.table === "policies" ? await policyWarnings(c, ins) : [] };
      });
      res.json({ data: out(row.ins), ...(row.warnings.length ? { warnings: row.warnings } : {}) });
    });
  }

  // DELETE: versionado = retire (is_current=false, mantém histórico); sales_history = delete físico. `why` obrigatório.
  r.delete("/:id", async (req, res) => {
    const ctx = ctxOf(res);
    requireUser(ctx);
    if (!uuidRe.test(req.params.id)) throw new HttpError(404, "not_found");
    const { why } = whySchema.parse({ why: (req.body as Row | undefined)?.why ?? req.query.why });
    await tx(res, async (c) => {
      if (def.table === "policies") await beforePolicyRetire(c, ctx, req.params.id); // W3b: 409 alcada_required_in_pack
      const q = def.versioned
        ? await c.query(`UPDATE ${def.table} SET is_current = false WHERE id = $1 AND is_current RETURNING id`, [req.params.id])
        : await c.query(`DELETE FROM ${def.table} WHERE id = $1 RETURNING id`, [req.params.id]);
      if (!q.rowCount) throw new HttpError(404, "not_found_or_not_current");
      await audit(c, ctx, def.versioned ? "retire" : "delete", def.table, req.params.id, { why });
    });
    res.status(204).end();
  });

  return r;
}

// ─── rate limit (in-memory, básico; trocar por edge/proxy em prod) ─
function rateLimit(perMinute: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "?";
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + 60_000 });
    else if (++h.n > perMinute) return res.status(429).json({ error: "rate_limited" });
    next();
  };
}

export function createApp(pool: Pool, opts: { corsOrigin?: string; rateLimitPerMinute?: number; ditadoLlm?: DitadoLlm | null } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  if (opts.corsOrigin) {
    app.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", opts.corsOrigin!);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "content-type, x-tenant-id, x-user-id");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE");
      if (req.method === "OPTIONS") return res.status(204).end();
      next();
    });
  }

  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true, db: "up", wave: "W0" });
    } catch {
      res.status(503).json({ ok: false, db: "down" });
    }
  });

  app.use(uiRouter(pool));

  const api = express.Router();
  api.use(rateLimit(opts.rateLimitPerMinute ?? 600));
  api.use(async (req, res, next) => {
    try { res.locals.ctx = await resolveCtx(pool, req); next(); } catch (e) { next(e); }
  });

  api.get("/me", (_req, res) => res.json({ data: ctxOf(res) }));
  api.get("/entities", (_req, res) =>
    res.json({ data: entities.map((e) => ({ path: e.path, versioned: e.versioned, fields: apiFields(e), aliases: e.aliases ?? {} })) }));

  mountCadastro(api, pool); // W3b/Task 9: tenant-settings (GET/PUT) + /cadastro/{packs,pack,alcada}

  // W1b: prontidão do cadastro p/ o A4 (tenant = header, como todo /api; RLS no banco). Só leitura, sem solver.
  api.get("/a4-readiness", async (_req, res) => {
    const [facts, confirmedAt] = await withTenant(pool, ctxOf(res).tenantId, async (c) => [await loadReadinessFacts(c),
      (await c.query("SELECT confirmed_at FROM tenant_settings")).rows[0]?.confirmed_at ?? null] as const);
    const data = computeReadiness(facts);
    // Helper de UX (0010): `state` NÃO considera confirmed_at. Novo cenário = confirmed && ready.
    const unlock = { confirmed: confirmedAt !== null, confirmed_at: confirmedAt, ready: data.state !== "block" };
    res.json({ data: { ...data, unlock: { ...unlock, new_scenario: unlock.confirmed && unlock.ready } } });
  });
  for (const def of entities) api.use(`/${def.path}`, entityRouter(pool, def));
  api.use("/premise_cards", premiseCardsRouter(pool)); // W1 slice 1 (Gap card → node stable_id)
  api.use("/a4-runs", a4RunsRouter(pool)); // W1c: run A4 (CBC em processo filho)
  api.use("/decision-events", decisionEventsRouter(pool)); // W2b/Task 7: A7 stub approve|escalate + why (append-only)
  api.use("/a7", a7Router(pool)); // T-A7-LEVE: POST /api/a7/evaluate (orchestrator state_machine_only; commit → DecisionEvent system)
  api.use("/pulse", pulseRouter(pool)); // W3/Task 8: summary + exceptions (GET only)
  api.use("/alcada", alcadaRouter(pool)); // W3/Task 8: fila de alçada (projeção derivada, GET only)
  api.use("/visoes", visoesRouter(pool)); // W3/Task 8: lentes sales|supply|finance (GET only)
  api.use("/execution", executionRouter(pool)); // W4/Task 10: movimentos de execução (append-only + void) → Pulse
  api.use("/journey", journeyRouter(pool)); // W5/Task 11: Journey D3 (lab → conviction pack → land)
  api.use("/plans", plansRouter(pool)); // W7/Task 13: export do plano aprovado (GET only, JSON/CSV attachment)
  mountWizard(api, pool, { ditadoLlm: opts.ditadoLlm }); // W2: cenários + ditado (LLM injetável)
  app.use("/api", api);

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(errorHandler);
  return app;
}

export { entityByPath };
