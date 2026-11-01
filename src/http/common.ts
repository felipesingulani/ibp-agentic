/** Helpers compartilhados pelos routers HTTP (cadastro genérico + premise_cards). */
import type { Response } from "express";
import { z } from "zod";
import type { Client } from "../db/pool.js";
import { HttpError } from "./errors.js";

export type Ctx = { tenantId: string; userId: string | null; role: string | null };
export type Row = Record<string, unknown>;

export const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const whySchema = z.object({ why: z.string().trim().min(1, "why é obrigatório em update/retire") });

export const ctxOf = (res: Response) => res.locals.ctx as Ctx;
export const requireUser = (ctx: Ctx) => { if (!ctx.userId) throw new HttpError(401, "x-user-id required for writes"); };

export async function audit(c: Client, ctx: Ctx, action: string, entity: string, entityId: string, payload: Row) {
  await c.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, actor_role, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ctx.tenantId, ctx.userId, ctx.role, action, entity, entityId, JSON.stringify(payload)]);
}

/**
 * Referência = `stable_id` de entidade com versão corrente (regra única p/ capacity, routes, sales, Gap card…).
 * Roda sob RLS → id de outro tenant não é encontrado; o banco ainda tem FK composta (tenant_id, stable_id).
 * id de linha-versão (v2+) ou identidade aposentada → 400 invalid_reference.
 */
export async function assertCurrentRefs(c: Client, table: "nodes" | "skus", field: string, ids: string[]) {
  if (!ids.length) return;
  const r = await c.query(
    `SELECT count(DISTINCT stable_id)::int AS n FROM ${table} WHERE stable_id = ANY($1::uuid[]) AND is_current`, [ids]);
  if (r.rows[0].n !== new Set(ids).size) {
    throw new HttpError(400, "invalid_reference", { field, hint: `use o stable_id corrente de ${table}` });
  }
}
