/**
 * W2 · Wizard API (docs/architecture/W2-WIZARD-API-CONTRACT.md). Montado por mountWizard() em app.ts.
 *   POST /api/scenarios {name, leg?}         → 201 draft v1 (code SCN-NNNN automático)
 *        403 scenario_locked (tenant_settings.confirmed_at nulo) · 409 a4_not_ready (prontidão = block)
 *   GET  /api/scenarios                      → cenários correntes
 *   GET  /api/scenarios/:id                  → cenário + cards (PremiseCard + extras)
 *   POST /api/scenarios/:id/premise_cards    → card (links.nodeId; Gap exige nó corrente → 400 invalid_reference)
 *   POST /api/scenarios/:id/ditado {text}    → LLM (mockável) → PremiseCard[] source=ditado; inválidos NÃO persistem
 *        502 ditado_unavailable (sem provedor/timeout/erro/teto) · 422 ditado_no_cards (nenhum cartão válido)
 *        A1 (T-A1-ENG): CurvaDemanda → v1 `a1.curva.v1` derivada no servidor; rejected[] a1_disabled|invalid_reference|duplicate_curve
 * A4: usar POST /api/a4-runs {scenario_id} (W1c) — sem alias.
 * Fora de escopo (contrato): decision-event (Task 7), alçada Finance, Pulse, export.
 */
import express, { type Router } from "express";
import { z } from "zod";
import { type Client, type Pool, withTenant } from "../db/pool.js";
import { computeReadiness, loadReadinessFacts } from "../domain/a4Readiness.js";
import { cardOut, insertCard, routeFields } from "../wizard/cards.js";
import { type DitadoLlm, DitadoService, DitadoUnavailable, ditadoServiceFromEnv, validateLlmCards } from "../wizard/ditado.js";
import { type Row, audit, ctxOf, requireUser, uuidRe } from "./common.js";
import { HttpError } from "./errors.js";
import { cardBody, cardCreateSchema } from "./premise-cards.js";

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  leg: z.enum(["sales", "supply", "finance", "composed"]).optional(),
}).strict();
const ditadoSchema = z.object({ text: z.string().trim().min(1, "ditado vazio").max(4000) }).strict();

const scenarioOut = (r: Row) => ({
  id: r.id, code: r.code, name: r.name, version: r.version, is_current: r.is_current, leg: r.leg ?? null,
  status: r.status, created_by: r.created_by ?? null, created_at: r.created_at,
});

/** Desbloqueio do wizard: confirmed_at (0010) e prontidão A4 ≠ block (W1b). */
export async function assertUnlocked(c: Client) {
  const confirmedAt = (await c.query("SELECT confirmed_at FROM tenant_settings")).rows[0]?.confirmed_at ?? null;
  if (!confirmedAt) throw new HttpError(403, "scenario_locked", { hint: "confirme o cadastro (PUT /api/tenant-settings {confirmed:true})" });
  const readiness = computeReadiness(await loadReadinessFacts(c));
  if (readiness.state === "block") throw new HttpError(409, "a4_not_ready", readiness);
}

async function currentScenario(c: Client, id: string): Promise<Row> {
  if (!uuidRe.test(id)) throw new HttpError(404, "not_found");
  const sc = (await c.query("SELECT * FROM scenarios WHERE id = $1 AND is_current", [id])).rows[0];
  if (!sc) throw new HttpError(404, "not_found");
  return sc;
}

export function scenariosRouter(pool: Pool, ditado: DitadoService): Router {
  const r = express.Router();

  r.post("/", async (req, res) => {
    const ctx = ctxOf(res);
    requireUser(ctx);
    const d = createSchema.parse(req.body ?? {});
    const row = await withTenant(pool, ctx.tenantId, async (c) => {
      await assertUnlocked(c);
      await c.query("SELECT pg_advisory_xact_lock(hashtext('scn:' || $1))", [ctx.tenantId]);
      const n = (await c.query(
        `SELECT coalesce(max((substring(code from '^SCN-(\\d+)$'))::int), 0) + 1 AS n FROM scenarios`)).rows[0].n as number;
      const ins = (await c.query(
        `INSERT INTO scenarios (tenant_id, code, name, version, is_current, leg, status, created_by)
         VALUES ($1, $2, $3, 1, true, $4, 'draft', $5) RETURNING *`,
        [ctx.tenantId, `SCN-${String(n).padStart(4, "0")}`, d.name, d.leg ?? null, ctx.userId])).rows[0];
      await audit(c, ctx, "create", "scenarios", String(ins.id), { version: 1, data: d });
      return ins;
    });
    res.status(201).json({ data: scenarioOut(row) });
  });

  r.get("/", async (_req, res) => {
    const rows = await withTenant(pool, ctxOf(res).tenantId, (c) =>
      c.query("SELECT * FROM scenarios WHERE is_current ORDER BY created_at DESC LIMIT 500").then((q) => q.rows));
    res.json({ data: rows.map(scenarioOut), count: rows.length });
  });

  r.get("/:id", async (req, res) => {
    const out = await withTenant(pool, ctxOf(res).tenantId, async (c) => {
      const sc = await currentScenario(c, req.params.id);
      const cards = (await c.query("SELECT * FROM premise_cards WHERE scenario_id = $1 ORDER BY card_id", [sc.id])).rows;
      return { ...scenarioOut(sc), cards: cards.map(cardOut) };
    });
    res.json({ data: out });
  });

  r.post("/:id/premise_cards", async (req, res) => {
    const ctx = ctxOf(res);
    requireUser(ctx);
    const why = typeof req.body?.why === "string" ? req.body.why : null;
    const d = cardCreateSchema.parse(cardBody(req.body));
    const row = await withTenant(pool, ctx.tenantId, async (c) => {
      const sc = await currentScenario(c, req.params.id);
      return insertCard(c, ctx, String(sc.id),
        { card_id: d.card_id, type: d.type, ...routeFields(d.type, d.fields ?? {}, d.status), node_id: d.node_id ?? null, source: d.source }, why);
    });
    res.status(201).json({ data: cardOut(row) });
  });

  r.post("/:id/ditado", async (req, res) => {
    const ctx = ctxOf(res);
    requireUser(ctx);
    const { text } = ditadoSchema.parse(req.body ?? {});
    // 1) contexto (nós correntes) — transação curta; LLM roda FORA de transação
    const { sc, nodes, skus } = await withTenant(pool, ctx.tenantId, async (c) => ({
      sc: await currentScenario(c, req.params.id),
      nodes: (await c.query("SELECT stable_id, code, name, node_type FROM nodes WHERE is_current ORDER BY code LIMIT 500")).rows,
      skus: (await c.query("SELECT stable_id, code, name FROM skus WHERE is_current ORDER BY code LIMIT 500")).rows,
    }));
    const dctx = { tenantId: ctx.tenantId, nodes: nodes as never, skus: skus as never };
    let raw: unknown, cached: boolean;
    try {
      ({ raw, cached } = await ditado.extract(text, dctx));
    } catch (e) {
      if (e instanceof DitadoUnavailable) throw new HttpError(502, "ditado_unavailable", { reason: e.reason });
      throw e;
    }
    const { cards, rejected, cardIndex } = validateLlmCards(raw, dctx);
    if (!cards.length) throw new HttpError(422, "ditado_no_cards", { rejected });
    // 2) persiste só os válidos; cada um com savepoint (nó aposentado no meio → rejeita só aquele)
    const saved = await withTenant(pool, ctx.tenantId, async (c) => {
      const out: Row[] = [];
      for (const [i, card] of cards.entries()) {
        await c.query("SAVEPOINT pc");
        try { out.push(await insertCard(c, ctx, String(sc.id), card, "ditado")); await c.query("RELEASE SAVEPOINT pc"); }
        catch (e) {
          await c.query("ROLLBACK TO SAVEPOINT pc");
          if (e instanceof HttpError) rejected.push({ index: cardIndex[i] ?? i, reason: e.message, detail: e.details }); else throw e;
        }
      }
      rejected.sort((a, b) => a.index - b.index); // fase 1 + fase 2 na ordem da saída do LLM
      if (!out.length) throw new HttpError(422, "ditado_no_cards", { rejected });
      await audit(c, ctx, "ditado", "scenarios", String(sc.id), { cached, cards: out.length, rejected: rejected.length, text_chars: text.length });
      return out;
    });
    res.status(201).json({ data: saved.map(cardOut), rejected, cached });
  });

  return r;
}

export function mountWizard(api: Router, pool: Pool, opts: { ditadoLlm?: DitadoLlm | null } = {}) {
  api.use("/scenarios", scenariosRouter(pool, ditadoServiceFromEnv(opts.ditadoLlm)));
}
