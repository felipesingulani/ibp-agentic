/**
 * W2 · cartões de premissa (contracts/premise-card.schema.json): validação única p/ edição manual e ditado.
 * - type ∈ NovaFilial|CurvaDemanda|Investimento|Gap; status ∈ ok|gap; source ∈ ditado|edit.
 * - fields: mapa livre (V0) mas seguro — chaves curtas, valores escalares, tamanho limitado (saída de LLM passa aqui).
 * - links.nodeId (= coluna node_id) = stable_id de nó CORRENTE; Gap exige → senão 400 invalid_reference.
 * - A1 (T-A1-ENG): type=CurvaDemanda ∧ fields.schema="a1.curva.v1" → `curvaFieldsSchema` (src/wizard/curva.ts):
 *   série/anchor.periodsUsed/trace/gapCode/status/uom DERIVADOS no servidor. CurvaDemanda legado (sem schema) = fieldsSchema.
 */
import { z } from "zod";
import type { Client } from "../db/pool.js";
import type { Ctx, Row } from "../http/common.js";
import { assertCurrentRefs, audit } from "../http/common.js";
import { HttpError } from "../http/errors.js";
import { type CurvaDraft, deriveCurva, isCurvaV1, mergeCurvaPatch, parseCurvaClient } from "./curva.js";

export const CARD_TYPES = ["NovaFilial", "CurvaDemanda", "Investimento", "Gap"] as const;
export type CardType = (typeof CARD_TYPES)[number];

const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
export const fieldsSchema = z.record(z.string().min(1).max(64), scalar)
  .refine((o) => Object.keys(o).length <= 30, "máx. 30 campos");

export interface CardInput {
  card_id?: string;
  type: CardType;
  fields: Record<string, unknown>;
  status: "ok" | "gap";
  node_id: string | null;
  source: "ditado" | "edit";
  /** A1 curva v1: servidor deriva fields/status a partir do draft (âncora + params). */
  curva?: CardCurva;
}
export type CardCurva = CurvaDraft;

/** Corpo cru de fields nas rotas (validação real por tipo/schema em `routeFields`). */
export const fieldsInput = z.record(z.string().min(1).max(64), z.unknown());

/**
 * Roteia validação por type/schema (POST manual): v1 → draft (derivados do cliente = 400); senão fieldsSchema escalar + status obrigatório.
 */
export function routeFields(type: CardType, fields: Record<string, unknown>, status: "ok" | "gap" | undefined):
  { fields: Record<string, unknown>; status: "ok" | "gap"; curva?: CurvaDraft } {
  if (isCurvaV1(type, fields)) {
    const { draft } = mergeCurvaPatch(null, parseCurvaClient(fields, status));
    return { fields: {}, status: "gap", curva: draft };
  }
  if (!status) throw new HttpError(400, "validation_failed", { field: "status", message: "status obrigatório" });
  return { fields: fieldsSchema.parse(fields), status };
}

/** links.nodeId (contrato) ou node_id (W1) → node_id. Conflito entre os dois → 400. */
export function nodeIdFrom(body: Row): string | null | undefined {
  const links = body.links as Row | undefined;
  const fromLinks = links && "nodeId" in links ? (links.nodeId as string | null) : undefined;
  if (fromLinks !== undefined && body.node_id !== undefined && fromLinks !== body.node_id) {
    throw new HttpError(400, "validation_failed", { field: "links.nodeId", message: "links.nodeId ≠ node_id" });
  }
  return fromLinks !== undefined ? fromLinks : (body.node_id as string | null | undefined);
}

export function gapNeedsNode(type: unknown, nodeId: unknown) {
  if (type === "Gap" && !nodeId) {
    throw new HttpError(400, "invalid_reference", { field: "links.nodeId", message: "Gap exige links.nodeId = stable_id de nó corrente" });
  }
}

export async function assertCardRefs(c: Client, type: unknown, nodeId: string | null | undefined) {
  gapNeedsNode(type, nodeId);
  if (nodeId) await assertCurrentRefs(c, "nodes", "links.nodeId", [nodeId]);
}

/** Próximo card_id do cenário (PC-<nº do cenário>-NN), sob lock transacional por cenário. */
export async function nextCardId(c: Client, scenarioId: string): Promise<string> {
  await c.query("SELECT pg_advisory_xact_lock(hashtext('pc:' || $1))", [scenarioId]);
  const sc = (await c.query("SELECT code FROM scenarios WHERE id = $1", [scenarioId])).rows[0];
  const num = String(sc?.code ?? "").replace(/\D/g, "") || "0";
  const n = (await c.query("SELECT count(*)::int AS n FROM premise_cards WHERE scenario_id = $1", [scenarioId])).rows[0].n as number;
  return `PC-${num.padStart(4, "0")}-${String(n + 1).padStart(2, "0")}`;
}

export async function insertCard(c: Client, ctx: Ctx, scenarioId: string, d: CardInput, why: string | null = null): Promise<Row> {
  await assertCardRefs(c, d.type, d.node_id);
  const cardId = d.card_id ?? (await nextCardId(c, scenarioId)); // advisory lock por cenário (serializa dedupe A1)
  if (d.curva) {
    const { curva: draft, ...rest } = d;
    const derived = await deriveCurva(c, scenarioId, draft, d.node_id);
    d = { ...rest, fields: derived.fields as unknown as Record<string, unknown>, status: derived.status };
  }
  const ins = (await c.query(
    `INSERT INTO premise_cards (tenant_id, scenario_id, card_id, type, fields, status, node_id, version, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8) RETURNING *`,
    [ctx.tenantId, scenarioId, cardId, d.type, JSON.stringify(d.fields), d.status, d.node_id, d.source])).rows[0];
  await audit(c, ctx, "create", "premise_cards", String(ins.id), { version: 1, why, data: { ...d, fields: auditFields(d.fields), card_id: cardId } });
  return ins;
}

/** Saída: linha + `links.nodeId` (campos do PremiseCard + extras card_id/scenario_id/node_id/tenant_id/created_at). */
export const cardOut = (r: Row) => ({ ...r, links: { nodeId: (r.node_id as string | null) ?? null } });

/** Projeção estrita no contrato (para validação/consumo estrito). */
export const toContractCard = (r: Row) => ({
  id: String(r.id), type: r.type, fields: r.fields ?? {}, status: r.status,
  links: { nodeId: (r.node_id as string | null) ?? null }, version: r.version, source: r.source,
});

/** Audit de curva v1: anchor + trace + params, sem a série completa (contrato A1 §7); demais tipos intactos. */
export function auditFields(fields: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(fields.series)) return fields;
  const { series, ...rest } = fields;
  return { ...rest, seriesLength: (series as unknown[]).length };
}
