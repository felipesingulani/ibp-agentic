/**
 * A1 CurvaDemanda v1 (docs/architecture/A1-CURVA-DEMANDA-CONTRACT.md · T-A1-ENG).
 * - `buildCurva(hist, params)` = função PURA e determinística (§5): hist (≤12 meses) → 18 pts mensais ou gap tipado.
 * - Série SEMPRE calculada no servidor; o LLM só dá intenção + parâmetros + âncora (série do LLM é descartada).
 * - Leitura de `sales_history` é SELECT puro sob RLS (withTenant); A1 nunca escreve em sales_history.
 * - Escrita só em `premise_cards.fields` (jsonb) — sem tabela auxiliar, sem migration, sem endpoint novo.
 */
import { z } from "zod";
import type { Client } from "../db/pool.js";
import { getPack, genericPack } from "../cadastro/packs.js";
import { assertCurrentRefs } from "../http/common.js";
import { HttpError } from "../http/errors.js";

export const CURVA_SCHEMA = "a1.curva.v1" as const;
export const CURVA_HORIZON = 18;
export const CURVA_MIN_HIST = 6;
export const CURVA_HIST_WINDOW = 12;
export const CURVA_MAX_BYTES = 8192;
export const PERFIS = ["natural", "linear", "degrau"] as const;
export type Perfil = (typeof PERFIS)[number];
export type GapCode = "hist_none" | "hist_insufficient" | "anchor_missing";
/** Campos derivados (servidor): cliente que envia qualquer um → 400 validation_failed. */
export const CURVA_DERIVED = ["series", "trace", "gapCode", "status", "uom"] as const;

const ym = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const uuid = z.uuid();
const maturidade = z.object({ pct: z.number().finite().min(1).max(200), mes: z.number().int().min(1).max(CURVA_HORIZON) }).strict();
const canibalizacao = z.object({
  pct: z.number().finite().min(-100).max(0),
  nodeStableId: uuid.nullable().default(null),
  nodeRef: z.string().trim().min(1).max(100).nullable().default(null),
}).strict();

/** Parâmetros editáveis (LLM/edit). Ausente → default (§4). */
export const curvaParamsSchema = z.object({
  perfil: z.enum(PERFIS).optional(),
  rampUpMeses: z.number().int().min(1).max(CURVA_HORIZON).optional(),
  maturidade: maturidade.optional(),
  canibalizacao: canibalizacao.nullable().optional(),
}).strict();
export type CurvaParamsInput = z.infer<typeof curvaParamsSchema>;
export interface CurvaParams { perfil: Perfil; rampUpMeses: number; maturidade: { pct: number; mes: number };
  canibalizacao: { pct: number; nodeStableId: string | null; nodeRef: string | null } | null }

/** Forma persistida completa (premise_cards.fields) — validada antes de gravar (teto 8 KB). */
export const curvaFieldsSchema = z.object({
  schema: z.literal(CURVA_SCHEMA),
  perfil: z.enum(PERFIS),
  rampUpMeses: z.number().int().min(1).max(CURVA_HORIZON),
  maturidade,
  canibalizacao: canibalizacao.nullable(),
  anchor: z.object({ nodeStableId: uuid.nullable(), skuStableId: uuid.nullable(), periodsUsed: z.number().int().min(0).max(CURVA_HIST_WINDOW) }).strict(),
  series: z.array(z.object({ period: ym, qty: z.number().finite().min(0), factor: z.number().finite() }).strict()),
  uom: z.string().max(40).nullable(),
  trace: z.object({ method: z.literal(CURVA_SCHEMA), histFrom: ym, histTo: ym, baseQty: z.number().finite(),
    histSource: z.literal("sales_history") }).strict().nullable(),
  gapCode: z.enum(["hist_none", "hist_insufficient", "anchor_missing"]).nullable(),
  nodeRef: z.string().max(100).nullable().optional(),
}).strict()
  .refine((f) => f.maturidade.mes >= f.rampUpMeses, { message: "maturidade.mes ≥ rampUpMeses", path: ["maturidade", "mes"] })
  .refine((f) => (f.gapCode === null) === (f.series.length === CURVA_HORIZON) && (f.gapCode === null || f.series.length === 0),
    { message: "ok ⇒ 18 pts; gap ⇒ series=[]", path: ["series"] })
  .refine((f) => f.anchor.nodeStableId !== null || f.gapCode === "anchor_missing", { message: "âncora obrigatória", path: ["anchor", "nodeStableId"] })
  .refine((f) => JSON.stringify(f).length <= CURVA_MAX_BYTES, { message: `fields > ${CURVA_MAX_BYTES} bytes` });
export type CurvaFields = z.infer<typeof curvaFieldsSchema>;

export const isCurvaV1 = (type: unknown, fields: unknown) =>
  type === "CurvaDemanda" && !!fields && typeof fields === "object" && (fields as Record<string, unknown>).schema === CURVA_SCHEMA;

/** Defaults + regra maturidade.mes ≥ rampUpMeses (400 validation_failed). */
export function resolveParams(p: CurvaParamsInput): CurvaParams {
  const rampUpMeses = p.rampUpMeses ?? 9;
  const mat = p.maturidade ?? { pct: 100, mes: rampUpMeses };
  if (mat.mes < rampUpMeses) {
    throw new HttpError(400, "validation_failed", { field: "fields.maturidade.mes", message: "maturidade.mes ≥ rampUpMeses" });
  }
  const can = p.canibalizacao ?? null;
  return { perfil: p.perfil ?? "natural", rampUpMeses, maturidade: { pct: mat.pct, mes: mat.mes },
    canibalizacao: can ? { pct: can.pct, nodeStableId: can.nodeStableId ?? null, nodeRef: can.nodeRef ?? null } : null };
}

export interface HistPoint { m: string; qty: number }
export interface CurvaResult {
  status: "ok" | "gap"; gapCode: GapCode | null; periodsUsed: number;
  series: { period: string; qty: number; factor: number }[];
  trace: CurvaFields["trace"];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
function addMonths(m: string, n: number): string {
  const [y, mo] = m.split("-").map(Number);
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

/** Fator f(t) do perfil (§5.4). t = 1..18. */
export function curvaFactor(perfil: Perfil, t: number, params: Pick<CurvaParams, "rampUpMeses" | "maturidade">): number {
  const P = params.maturidade.pct / 100, M = params.maturidade.mes;
  if (perfil === "linear") return P * Math.min(t / M, 1);
  if (perfil === "degrau") return t < params.rampUpMeses ? 0 : P;
  const s = (x: number) => 1 / (1 + Math.exp(-(10 / M) * (x - M / 2)));
  return t >= M ? P : (P * s(t)) / s(M);
}

/**
 * PURA (§5): hist = meses agregados do âncora (qualquer ordem; usa os 12 mais recentes distintos).
 * 0 → gap hist_none · 1–5 → gap hist_insufficient · ≥6 → ok com 18 pts (qty ≥ 0, 2 casas; factor 4 casas).
 */
export function buildCurva(hist: HistPoint[], params: CurvaParams): CurvaResult {
  const byMonth = new Map<string, number>();
  for (const h of hist) byMonth.set(h.m, (byMonth.get(h.m) ?? 0) + Number(h.qty));
  const H = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)).slice(0, CURVA_HIST_WINDOW);
  const periodsUsed = H.length;
  if (periodsUsed === 0) return { status: "gap", gapCode: "hist_none", periodsUsed, series: [], trace: null };
  const baseQty = r2(H.reduce((s, [, q]) => s + q, 0) / periodsUsed);
  const histTo = H[0][0], histFrom = H[H.length - 1][0];
  const trace = { method: CURVA_SCHEMA, histFrom, histTo, baseQty, histSource: "sales_history" as const };
  if (periodsUsed < CURVA_MIN_HIST) return { status: "gap", gapCode: "hist_insufficient", periodsUsed, series: [], trace };
  const series = Array.from({ length: CURVA_HORIZON }, (_, i) => {
    const f = curvaFactor(params.perfil, i + 1, params);
    return { period: addMonths(histTo, i + 1), qty: Math.max(0, r2(baseQty * f)), factor: r4(f) };
  });
  return { status: "ok", gapCode: null, periodsUsed, series, trace };
}

// ─── IO (sempre dentro de withTenant → RLS) ─────────────────────────────

/** §5.1 — SELECT puro (RLS do tenant). node_id/sku_id de sales_history = stable_id (0006). */
export async function loadHist(c: Client, nodeStableId: string, skuStableId: string | null): Promise<HistPoint[]> {
  const q = await c.query(
    `SELECT left(period, 7) AS m, sum(qty)::float8 AS qty FROM sales_history
      WHERE node_id = $1 AND ($2::uuid IS NULL OR sku_id = $2::uuid)
      GROUP BY 1 ORDER BY 1 DESC LIMIT ${CURVA_HIST_WINDOW}`, [nodeStableId, skuStableId]);
  return q.rows.map((r) => ({ m: String(r.m), qty: Number(r.qty) }));
}

/** Roster efetivo A1 = pack (NULL ≡ generic) + override tenant_settings.agent_roster. */
export async function a1Enabled(c: Client): Promise<boolean> {
  const row = (await c.query("SELECT industry_pack, agent_roster FROM tenant_settings")).rows[0];
  const pack = (typeof row?.industry_pack === "string" && getPack(row.industry_pack)) || genericPack();
  const stored = (row?.agent_roster ?? {}) as Record<string, { enabled?: boolean }>;
  const a1 = stored.A1 ?? (pack.agents as Record<string, { enabled?: boolean }>).A1;
  return a1?.enabled === true;
}
export async function assertA1Enabled(c: Client) {
  if (!(await a1Enabled(c))) throw new HttpError(409, "a1_disabled", { agent: "A1", hint: "A1 desligado no roster (pack/tenant_settings)" });
}

async function tenantUom(c: Client): Promise<string | null> {
  const row = (await c.query("SELECT industry_pack, uom FROM tenant_settings")).rows[0];
  if (typeof row?.uom === "string" && row.uom) return row.uom;
  const pack = (typeof row?.industry_pack === "string" && getPack(row.industry_pack)) || genericPack();
  return pack.uom ?? null;
}

/** H4: mesma (anchor.nodeStableId, anchor.skuStableId, links.nodeId) já existe no cenário → duplicate_curve. */
export async function assertNoDuplicateCurve(c: Client, scenarioId: string, anchorNode: string | null, sku: string | null,
  linksNodeId: string | null, exceptId: string | null = null) {
  const dup = (await c.query(
    `SELECT id, card_id FROM premise_cards
      WHERE scenario_id = $1 AND type = 'CurvaDemanda' AND fields->>'schema' = '${CURVA_SCHEMA}'
        AND (fields->'anchor'->>'nodeStableId') IS NOT DISTINCT FROM $2
        AND (fields->'anchor'->>'skuStableId') IS NOT DISTINCT FROM $3
        AND node_id IS NOT DISTINCT FROM $4::uuid
        AND ($5::uuid IS NULL OR id <> $5::uuid)
      LIMIT 1`, [scenarioId, anchorNode, sku, linksNodeId, exceptId])).rows[0];
  if (dup) throw new HttpError(409, "duplicate_curve", { cardId: dup.card_id, id: dup.id });
}

export interface CurvaDraft {
  params: CurvaParams;
  /** stable_id já resolvido (current) ou null (sem âncora → gap anchor_missing). */
  anchorNodeStableId: string | null;
  skuStableId: string | null;
  nodeRef?: string | null;
  /** ditado: ref do LLM que não resolveu p/ nó/SKU current → invalid_reference (checado APÓS o roster, §3 ordem). */
  invalid?: { field: string; ref: string };
}

/**
 * Pipeline servidor (§3 passos 1–5): roster → âncora/SKU current do tenant → hist → série/gap → dedupe.
 * Retorna fields v1 completos + status derivado. Não escreve nada.
 */
export async function deriveCurva(c: Client, scenarioId: string, d: CurvaDraft, linksNodeId: string | null,
  exceptId: string | null = null): Promise<{ fields: CurvaFields; status: "ok" | "gap" }> {
  await assertA1Enabled(c);
  await c.query("SELECT pg_advisory_xact_lock(hashtext('pc:' || $1))", [scenarioId]); // mesmo lock do nextCardId (dedupe H4)
  if (d.invalid) throw new HttpError(400, "invalid_reference", { field: d.invalid.field, ref: d.invalid.ref });
  if (d.anchorNodeStableId) await assertCurrentRefs(c, "nodes", "fields.anchor.nodeStableId", [d.anchorNodeStableId]);
  if (d.skuStableId) await assertCurrentRefs(c, "skus", "fields.anchor.skuStableId", [d.skuStableId]);
  const can = d.params.canibalizacao;
  if (can?.nodeStableId) await assertCurrentRefs(c, "nodes", "fields.canibalizacao.nodeStableId", [can.nodeStableId]);
  const res: CurvaResult = d.anchorNodeStableId
    ? buildCurva(await loadHist(c, d.anchorNodeStableId, d.skuStableId), d.params)
    : { status: "gap", gapCode: "anchor_missing", periodsUsed: 0, series: [], trace: null };
  await assertNoDuplicateCurve(c, scenarioId, d.anchorNodeStableId, d.skuStableId, linksNodeId, exceptId);
  const parsed = curvaFieldsSchema.safeParse({
    schema: CURVA_SCHEMA, ...d.params,
    anchor: { nodeStableId: d.anchorNodeStableId, skuStableId: d.skuStableId, periodsUsed: res.periodsUsed },
    series: res.series, uom: await tenantUom(c), trace: res.trace, gapCode: res.gapCode,
    ...(d.nodeRef ? { nodeRef: d.nodeRef } : {}),
  });
  if (!parsed.success) throw new HttpError(400, "validation_failed", { field: "fields", issues: parsed.error.issues.slice(0, 3) });
  return { fields: parsed.data, status: res.status };
}

/** Rejeita derivados vindos do cliente (POST manual / PATCH) → 400 validation_failed. */
export function assertNoDerived(fields: Record<string, unknown>, topStatus: unknown) {
  for (const k of CURVA_DERIVED) {
    if (k in fields) throw new HttpError(400, "validation_failed", { field: `fields.${k}`, message: "campo derivado (servidor)" });
  }
  const anchor = fields.anchor as Record<string, unknown> | undefined;
  if (anchor && typeof anchor === "object" && "periodsUsed" in anchor) {
    throw new HttpError(400, "validation_failed", { field: "fields.anchor.periodsUsed", message: "campo derivado (servidor)" });
  }
  if (topStatus !== undefined) throw new HttpError(400, "validation_failed", { field: "status", message: "status da curva v1 é derivado" });
}

/** Corpo cliente (POST manual / PATCH) de curva v1: params + anchor {nodeStableId?, skuStableId?} + nodeRef? */
export const curvaClientSchema = z.object({
  schema: z.literal(CURVA_SCHEMA).optional(),
  perfil: z.enum(PERFIS).optional(),
  rampUpMeses: z.number().int().min(1).max(CURVA_HORIZON).optional(),
  maturidade: maturidade.optional(),
  canibalizacao: canibalizacao.nullable().optional(),
  // string (não uuid) p/ que âncora inexistente/malformada vire invalid_reference (contrato §3), não validation_failed
  anchor: z.object({ nodeStableId: z.string().max(100).nullable().optional(), skuStableId: z.string().max(100).nullable().optional() }).strict().optional(),
  nodeRef: z.string().trim().min(1).max(100).nullable().optional(),
}).strict();
export type CurvaClientInput = z.infer<typeof curvaClientSchema>;

export function parseCurvaClient(fields: Record<string, unknown>, topStatus: unknown): CurvaClientInput {
  assertNoDerived(fields, topStatus);
  const p = curvaClientSchema.safeParse(fields);
  if (!p.success) {
    const i = p.error.issues[0];
    throw new HttpError(400, "validation_failed", { field: `fields.${i.path.join(".")}`, message: i.message, issues: p.error.issues.slice(0, 3) });
  }
  return p.data;
}

/**
 * PATCH: merge dos params editados sobre o card v1 anterior (ou defaults se legado → v1).
 * Se o cliente muda rampUpMeses sem mandar maturidade e a maturidade anterior seguia o default (mes = ramp anterior),
 * mes acompanha o novo ramp (senão a série natural/linear não mudaria).
 */
export function mergeCurvaPatch(prev: Record<string, unknown> | null, patch: CurvaClientInput):
  { draft: CurvaDraft } {
  const pv = prev && prev.schema === CURVA_SCHEMA ? (prev as unknown as CurvaFields) : null;
  const prevRamp = pv?.rampUpMeses ?? 9;
  const ramp = patch.rampUpMeses ?? prevRamp;
  let mat = patch.maturidade ?? pv?.maturidade;
  if (!patch.maturidade && mat && patch.rampUpMeses !== undefined && mat.mes === prevRamp) mat = { pct: mat.pct, mes: ramp };
  const params = resolveParams({
    perfil: patch.perfil ?? pv?.perfil, rampUpMeses: ramp, maturidade: mat,
    canibalizacao: patch.canibalizacao !== undefined ? patch.canibalizacao : pv?.canibalizacao ?? null,
  });
  const anchorNode = patch.anchor && "nodeStableId" in patch.anchor ? patch.anchor.nodeStableId ?? null : pv?.anchor.nodeStableId ?? null;
  const sku = patch.anchor && "skuStableId" in patch.anchor ? patch.anchor.skuStableId ?? null : pv?.anchor.skuStableId ?? null;
  const nodeRef = patch.nodeRef !== undefined ? patch.nodeRef : (pv?.nodeRef ?? (typeof prev?.nodeRef === "string" ? prev.nodeRef : null));
  const isUuid = (v: string | null) => v === null || uuid.safeParse(v).success;
  const invalid = !isUuid(anchorNode) ? { field: "fields.anchor.nodeStableId", ref: anchorNode as string }
    : !isUuid(sku) ? { field: "fields.anchor.skuStableId", ref: sku as string } : undefined;
  return { draft: { params, anchorNodeStableId: invalid ? null : anchorNode, skuStableId: invalid ? null : sku, nodeRef,
    ...(invalid ? { invalid } : {}) } };
}
