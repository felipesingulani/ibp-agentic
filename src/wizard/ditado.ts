/**
 * W2 · Ditado → PremiseCard[] (W2-WIZARD-API-CONTRACT.md · "LLM (só aqui)").
 * Único ponto do código com chamada de LLM (gate W2 nega marcadores de cliente LLM fora de src/wizard/).
 *
 * - `DitadoLlm` é injetável (createApp(pool, { ditadoLlm })) → testes SEMPRE usam mock (sem rede).
 * - Default: provedor HTTP genérico (formato "messages" compatível; sem SDK/vendor) configurado por env:
 *     DITADO_LLM_URL, DITADO_LLM_KEY, DITADO_LLM_MODEL (modelo barato), DITADO_TIMEOUT_MS (default 8000),
 *     DITADO_DAILY_CALL_CAP (default 300/dia/processo ≈ guarda do teto US$100/mês; contabilidade real = residual).
 *   Sem env → provedor indisponível → 502 ditado_unavailable.
 * - Cache em memória por sha256(tenant, texto normalizado) (TTL 24h, máx. 500) guarda a saída CRUA do LLM;
 *   a validação (nós correntes) roda sempre de novo.
 * - Saída do LLM é não confiável: cada cartão passa por validação de contrato; inválidos NÃO persistem.
 * - A1 (T-A1-ENG · A1-CURVA-DEMANDA-CONTRACT.md §3): todo CurvaDemanda do ditado vira v1 (`a1.curva.v1`) — o LLM só dá
 *   intenção/params/anchorRef/skuRef; qualquer series/qty do LLM é DESCARTADO; a série é derivada no servidor (curva.ts).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { CARD_TYPES, type CardInput, fieldsSchema } from "./cards.js";
import { type CurvaDraft, type CurvaParamsInput, curvaParamsSchema, resolveParams } from "./curva.js";
import { HttpError } from "../http/errors.js";

export interface DitadoNode { stable_id: string; code: string; name: string; node_type: string | null }
export interface DitadoSku { stable_id: string; code: string; name: string }
export interface DitadoContext { tenantId: string; nodes: DitadoNode[]; skus?: DitadoSku[] }
/** Saída crua esperada do LLM: { cards: [{ type, fields, status?, nodeRef? }] } (nodeRef = code ou stable_id). */
export interface DitadoLlm { extract(text: string, ctx: DitadoContext, signal: AbortSignal): Promise<unknown> }

export class DitadoUnavailable extends Error {
  constructor(public reason: string) { super(`ditado_unavailable: ${reason}`); }
}

const rawCard = z.object({
  type: z.enum(CARD_TYPES),
  fields: fieldsSchema.default({}),
  status: z.enum(["ok", "gap"]).optional(),
  nodeRef: z.string().max(100).nullable().optional(),
  links: z.object({ nodeId: z.string().max(100).nullable() }).optional(),
});
const rawOut = z.object({ cards: z.array(z.unknown()).max(20) });
const ref = z.string().trim().min(1).max(100).nullable().optional();
/** CurvaDemanda (A1): fields com objetos aninhados; só as chaves de parâmetro são lidas (series/qty/demais = descartados). */
const rawCurva = z.object({
  type: z.literal("CurvaDemanda"),
  anchorRef: ref, skuRef: ref, nodeRef: ref,
  links: z.object({ nodeId: z.string().max(100).nullable() }).optional(),
  status: z.unknown().optional(),
  fields: z.record(z.string(), z.unknown()).default({}),
});
const PARAM_KEYS = ["perfil", "rampUpMeses", "maturidade", "canibalizacao"] as const;

export interface Rejected { index: number; reason: string; detail?: unknown }

/** Valida + resolve nó (code|stable_id → stable_id corrente). Gap sem nó corrente → rejeitado (invalid_reference). */
export function validateLlmCards(raw: unknown, ctx: DitadoContext): { cards: Omit<CardInput, "card_id">[]; rejected: Rejected[]; cardIndex: number[] } {
  const top = rawOut.safeParse(raw);
  if (!top.success) return { cards: [], rejected: [{ index: -1, reason: "invalid_output", detail: top.error.issues.slice(0, 3) }], cardIndex: [] };
  const byKey = new Map<string, string>();
  for (const n of ctx.nodes) { byKey.set(n.stable_id, n.stable_id); byKey.set(n.code.toLowerCase(), n.stable_id); }
  const cards: Omit<CardInput, "card_id">[] = [];
  const cardIndex: number[] = []; // índice original na saída do LLM (p/ rejected[] da fase 2 apontar o cartão certo)
  const rejected: Rejected[] = [];
  const skuByKey = new Map<string, string>();
  for (const k of ctx.skus ?? []) { skuByKey.set(k.stable_id, k.stable_id); skuByKey.set(k.code.toLowerCase(), k.stable_id); }
  const look = (m: Map<string, string>, r: string | null | undefined) => (r ? m.get(r) ?? m.get(r.toLowerCase()) ?? null : null);
  top.data.cards.forEach((c, index) => {
    if ((c as { type?: unknown } | null)?.type === "CurvaDemanda") {
      const out = curvaFromLlm(c, look.bind(null, byKey), look.bind(null, skuByKey));
      if ("reason" in out) rejected.push({ index, ...out }); else { cards.push(out); cardIndex.push(index); }
      return;
    }
    const p = rawCard.safeParse(c);
    if (!p.success) { rejected.push({ index, reason: "validation_failed", detail: p.error.issues.slice(0, 3) }); return; }
    const ref = p.data.links?.nodeId ?? p.data.nodeRef ?? null;
    const nodeId = ref ? byKey.get(ref) ?? byKey.get(ref.toLowerCase()) ?? null : null;
    if (p.data.type === "Gap" && !nodeId) {
      rejected.push({ index, reason: "invalid_reference", detail: { field: "links.nodeId", ref } }); return;
    }
    // Não-Gap com ref desconhecida (ex.: filial nova ainda não cadastrada) → sem vínculo; ref fica nos fields.
    const fields = ref && !nodeId ? { ...p.data.fields, nodeRef: ref } : p.data.fields;
    cards.push({ type: p.data.type, fields, status: p.data.type === "Gap" ? "gap" : (p.data.status ?? "ok"), node_id: nodeId, source: "ditado" });
    cardIndex.push(index);
  });
  return { cards, rejected, cardIndex };
}

/** LLM → CardInput com draft A1 (sem números). Refs inválidas viram `draft.invalid` (rejeição após o roster, na fase 2). */
function curvaFromLlm(c: unknown, node: (r: string | null | undefined) => string | null, sku: (r: string | null | undefined) => string | null):
  Omit<CardInput, "card_id"> | Omit<Rejected, "index"> {
  const p = rawCurva.safeParse(c);
  if (!p.success) return { reason: "validation_failed", detail: p.error.issues.slice(0, 3) };
  const picked: Record<string, unknown> = {};
  for (const k of PARAM_KEYS) if (p.data.fields[k] !== undefined) picked[k] = p.data.fields[k];
  const can = picked.canibalizacao as Record<string, unknown> | null | undefined;
  if (can && typeof can === "object") {
    const cref = typeof can.nodeRef === "string" ? can.nodeRef : null;
    picked.canibalizacao = { pct: can.pct, nodeStableId: node(cref), nodeRef: cref };
  }
  const pp = curvaParamsSchema.safeParse(picked);
  if (!pp.success) return { reason: "validation_failed", detail: pp.error.issues.slice(0, 3) };
  let params;
  try { params = resolveParams(pp.data as CurvaParamsInput); }
  catch (e) { if (e instanceof HttpError) return { reason: e.message, detail: e.details }; throw e; }
  const target = p.data.links?.nodeId ?? p.data.nodeRef ?? null;
  const nodeId = node(target);
  const anchorRef = p.data.anchorRef ?? null, skuRef = p.data.skuRef ?? null;
  const anchor = node(anchorRef), skuId = sku(skuRef);
  const curva: CurvaDraft = {
    params, anchorNodeStableId: anchor, skuStableId: skuId, nodeRef: target && !nodeId ? target : null,
    ...(anchorRef && !anchor ? { invalid: { field: "fields.anchor.nodeStableId", ref: anchorRef } }
      : skuRef && !skuId ? { invalid: { field: "fields.anchor.skuStableId", ref: skuRef } } : {}),
  };
  return { type: "CurvaDemanda", fields: {}, status: "gap", node_id: nodeId, source: "ditado", curva };
}

export function ditadoCacheKey(tenantId: string, text: string) {
  return createHash("sha256").update(tenantId).update("\u0000").update(text.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex");
}

export class DitadoService {
  private cache = new Map<string, { at: number; raw: unknown }>();
  private day = ""; private calls = 0;
  constructor(private llm: DitadoLlm | null, private opts: { timeoutMs?: number; dailyCap?: number; ttlMs?: number } = {}) {}

  async extract(text: string, ctx: DitadoContext): Promise<{ raw: unknown; cached: boolean }> {
    const key = ditadoCacheKey(ctx.tenantId, text);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < (this.opts.ttlMs ?? 86_400_000)) return { raw: hit.raw, cached: true };
    if (!this.llm) throw new DitadoUnavailable("not_configured");
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.calls = 0; }
    if (this.calls >= (this.opts.dailyCap ?? 300)) throw new DitadoUnavailable("budget_cap");
    this.calls++;
    let raw: unknown;
    try {
      raw = await this.llm.extract(text, ctx, AbortSignal.timeout(this.opts.timeoutMs ?? 8000));
    } catch (e) {
      throw new DitadoUnavailable((e as Error)?.name === "TimeoutError" ? "timeout" : "provider_error");
    }
    if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { at: Date.now(), raw });
    return { raw, cached: false };
  }
}

const SYSTEM = [
  "Você converte um ditado de planejamento (pt-BR) em cartões de premissa JSON.",
  'Responda SOMENTE JSON: {"cards":[{"type":"NovaFilial|CurvaDemanda|Investimento|Gap","fields":{<chave>:<texto|número>},"status":"ok|gap","nodeRef":"<code de nó da lista ou null>"}]}.',
  "Use Gap quando faltar dado/capacidade e aponte nodeRef para um nó EXISTENTE da lista. Não invente códigos de nó para Gap.",
  'Para CurvaDemanda use: {"type":"CurvaDemanda","anchorRef":"<code do nó da lista usado como referência (semelhante a X) ou null>","skuRef":"<code de SKU da lista ou null>","nodeRef":"<nó alvo/filial nova ou null>","fields":{"perfil":"natural|linear|degrau","rampUpMeses":<1-18>,"maturidade":{"pct":<1-200>,"mes":<1-18>},"canibalizacao":{"pct":<-100..0>,"nodeRef":"<code>"}|null}}.',
  "NUNCA gere números de série/demanda mensal: a curva é calculada pelo sistema a partir do histórico.",
  "Não use termos de setor que não estejam no ditado.",
].join(" ");

/** Provedor HTTP genérico via env (sem SDK). null se não configurado. */
export function httpDitadoLlmFromEnv(env: NodeJS.ProcessEnv = process.env): DitadoLlm | null {
  const url = env.DITADO_LLM_URL, key = env.DITADO_LLM_KEY, model = env.DITADO_LLM_MODEL;
  if (!url || !key || !model) return null;
  return {
    async extract(text, ctx, signal) {
      const nodes = ctx.nodes.slice(0, 200).map((n) => ({ code: n.code, name: n.name, type: n.node_type }));
      const skus = (ctx.skus ?? []).slice(0, 200).map((k) => ({ code: k.code, name: k.name }));
      const r = await fetch(url, {
        method: "POST", signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model, temperature: 0, max_tokens: 900, response_format: { type: "json_object" },
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify({ ditado: text, nodes, skus }) }],
        }),
      });
      if (!r.ok) throw new Error(`llm http ${r.status}`);
      const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
      return JSON.parse(j.choices?.[0]?.message?.content ?? "null");
    },
  };
}

export function ditadoServiceFromEnv(llm?: DitadoLlm | null): DitadoService {
  return new DitadoService(llm === undefined ? httpDitadoLlmFromEnv() : llm, {
    timeoutMs: Number(process.env.DITADO_TIMEOUT_MS ?? 8000) || 8000,
    dailyCap: Number(process.env.DITADO_DAILY_CALL_CAP ?? 300) || 300,
  });
}
