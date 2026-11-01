/**
 * premise_cards (W1 slice 1 → alinhado ao contrato W2: contracts/premise-card.schema.json).
 * Card não é versionado por linha: PATCH atualiza a linha, incrementa `version`, grava `source=edit` e audita (`why`).
 *
 * Regras (src/wizard/cards.ts):
 * - nó = `links.nodeId` (ou `node_id`, W1) = stable_id de nó CORRENTE. Gap sem nó, id de linha-versão, nó aposentado
 *   ou de outro tenant → 400 invalid_reference. FK composta (tenant_id, node_id) → nodes_identity no banco.
 * - scenario_id: FK composta (tenant_id, scenario_id) rejeita cenário de outro tenant → 400 invalid_reference.
 * Criação no fluxo do wizard: rota aninhada no router de cenários (src/http/scenarios.ts; card_id automático).
 */
import express, { type Response } from "express";
import { z } from "zod";
import { type Client, type Pool, withTenant } from "../db/pool.js";
import { CARD_TYPES, auditFields, cardOut, fieldsInput, fieldsSchema, gapNeedsNode, insertCard, nodeIdFrom, routeFields } from "../wizard/cards.js";
import { CURVA_SCHEMA, deriveCurva, mergeCurvaPatch, parseCurvaClient } from "../wizard/curva.js";
import { type Ctx, type Row, assertCurrentRefs, audit, ctxOf, requireUser, uuidRe, whySchema } from "./common.js";
import { HttpError } from "./errors.js";

export const cardCreateSchema = z.object({
  card_id: z.string().trim().min(1).max(64).optional(),
  type: z.enum(CARD_TYPES),
  fields: fieldsInput.optional(), // validação por type/schema em routeFields (legado = fieldsSchema escalar)
  status: z.enum(["ok", "gap"]).optional(), // obrigatório exceto curva A1 v1 (derivado)
  node_id: z.uuid().nullable().optional(),
  source: z.enum(["ditado", "edit"]).default("edit"),
}).strict();
const createSchema = cardCreateSchema.extend({ scenario_id: z.uuid(), card_id: z.string().trim().min(1).max(64) }).strict();
const patchSchema = z.object({
  fields: fieldsInput.optional(), status: z.enum(["ok", "gap"]).optional(), node_id: z.uuid().nullable().optional(),
  source: z.literal("edit").optional(),
}).strict();

/** Normaliza `links` → `node_id` e remove campos que não são do corpo (why). */
export function cardBody(raw: unknown): Row {
  const { why: _w, links: _l, ...body } = (raw ?? {}) as Row;
  const nodeId = nodeIdFrom((raw ?? {}) as Row);
  return nodeId === undefined ? body : { ...body, node_id: nodeId };
}

export function premiseCardsRouter(pool: Pool) {
  const r = express.Router();
  const tx = <T>(res: Response, fn: (c: Client, ctx: Ctx) => Promise<T>) =>
    withTenant(pool, ctxOf(res).tenantId, (c) => fn(c, ctxOf(res)));

  r.get("/", async (req, res) => {
    const where: string[] = [];
    const params: unknown[] = [];
    for (const f of ["scenario_id", "node_id", "type", "status", "card_id"]) {
      const v = req.query[f];
      if (typeof v !== "string") continue;
      if (f.endsWith("_id") && f !== "card_id" && !uuidRe.test(v)) throw new HttpError(400, "invalid_input", { field: f });
      params.push(v); where.push(`${f} = $${params.length}`);
    }
    const limit = Math.min(Number(req.query.limit ?? 500) || 500, 5000);
    const rows = await tx(res, (c) => c.query(
      `SELECT * FROM premise_cards ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at, card_id LIMIT ${limit}`,
      params).then((q) => q.rows));
    res.json({ data: rows.map(cardOut), count: rows.length });
  });

  r.get("/:id", async (req, res) => {
    if (!uuidRe.test(req.params.id)) throw new HttpError(404, "not_found");
    const row = await tx(res, (c) => c.query("SELECT * FROM premise_cards WHERE id = $1", [req.params.id]).then((q) => q.rows[0]));
    if (!row) throw new HttpError(404, "not_found");
    res.json({ data: cardOut(row) });
  });

  r.post("/", async (req, res) => {
    const ctx = ctxOf(res);
    requireUser(ctx);
    const why = typeof req.body?.why === "string" ? req.body.why : null;
    const d = createSchema.parse(cardBody(req.body));
    const row = await tx(res, (c) => insertCard(c, ctx, d.scenario_id,
      { card_id: d.card_id, type: d.type, ...routeFields(d.type, d.fields ?? {}, d.status), node_id: d.node_id ?? null, source: d.source }, why));
    res.status(201).json({ data: cardOut(row) });
  });

  r.patch("/:id", async (req, res) => {
    const ctx = ctxOf(res);
    requireUser(ctx);
    if (!uuidRe.test(req.params.id)) throw new HttpError(404, "not_found");
    const { why } = whySchema.parse(req.body ?? {});
    const p = patchSchema.parse(cardBody(req.body));
    const row = await tx(res, async (c) => {
      const prev = (await c.query("SELECT * FROM premise_cards WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
      if (!prev) throw new HttpError(404, "not_found");
      const nodeId = "node_id" in p ? p.node_id ?? null : prev.node_id;
      gapNeedsNode(prev.type, nodeId); // Gap não perde o nó
      if ("node_id" in p && nodeId) await assertCurrentRefs(c, "nodes", "links.nodeId", [nodeId]);
      let fields: Record<string, unknown> = prev.fields, status = p.status ?? prev.status;
      // A1 curva v1: params editáveis → servidor re-resolve âncora + relê hist + recalcula (ok ↔ gap); derivados do cliente = 400
      const v1 = prev.type === "CurvaDemanda" && (prev.fields?.schema === CURVA_SCHEMA || p.fields?.schema === CURVA_SCHEMA);
      if (v1) {
        const { draft } = mergeCurvaPatch(prev.fields as Record<string, unknown>, parseCurvaClient(p.fields ?? {}, p.status));
        const derived = await deriveCurva(c, String(prev.scenario_id), draft, nodeId, String(prev.id));
        fields = derived.fields as unknown as Record<string, unknown>; status = derived.status;
      } else if (p.fields) fields = fieldsSchema.parse(p.fields);
      const upd = (await c.query(
        `UPDATE premise_cards SET fields = $2, status = $3, node_id = $4, source = 'edit', version = version + 1
          WHERE id = $1 RETURNING *`,
        [prev.id, JSON.stringify(fields), status, nodeId])).rows[0];
      const changes = v1 ? { ...p, fields: auditFields(fields) } : p;
      await audit(c, ctx, "update", "premise_cards", String(upd.id),
        { why, previous_version: prev.version, version: upd.version, previous_source: prev.source, source: "edit", changes });
      return upd;
    });
    res.json({ data: cardOut(row) });
  });

  return r;
}
