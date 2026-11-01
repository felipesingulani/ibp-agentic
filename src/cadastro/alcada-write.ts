/**
 * W3b · Task 9 — hook ÚNICO de escrita da POL de alçada (Regras 2, 3, 5 do contrato W3B). Usado por:
 *   PUT /api/cadastro/alcada (upsertAlcada), POST /api/cadastro/pack (applyPackAlcada) e o CRUD genérico de
 *   /api/policies (beforePolicyCreate / beforePolicyPatch / beforePolicyRetire em src/http/app.ts).
 * Invariantes: ≤ 1 POL de alçada corrente em pack com alçada; última não se retira em pack com alçada (limpar = limitMi:null);
 * publicar alçada fora do pack → switch p/ generic (só policy_kinds.alcada + industry_pack). Sempre sob lockTenant + audit.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "../db/pool.js";
import { type Ctx, audit } from "../http/common.js";
import { HttpError } from "../http/errors.js";
import { type EffectivePolicyKinds, effectivePolicyKinds, normalizeKind, toStored } from "../domain/policy-kinds.js";
import { GENERIC, type PackProfile, genericPack, getPack } from "./packs.js";
import { lockTenant, readSettingsRow } from "./settings.js";

type PolRow = Record<string, unknown> & { id: string; stable_id: string; version: number; kind: string; name: string; body: unknown };

/** limitMi do contrato: number finito ≥ 0 ou null. String/negativo/NaN → 400 (readMi da Task 8 segue tolerante p/ legado). */
export function validateLimitMi(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  throw new HttpError(400, "invalid_limit_mi", { expected: "number ≥ 0 | null", got: typeof v });
}

const genericAliases = () => genericPack().policy_kinds.alcada!;

async function tenantKinds(c: Client) {
  const row = await readSettingsRow(c);
  return { row, kinds: effectivePolicyKinds(row?.policy_kinds ?? {}) };
}

const isIn = (kind: string, aliases: readonly string[]) => aliases.includes(normalizeKind(kind));

async function currentAlcada(c: Client, aliases: readonly string[]): Promise<PolRow[]> {
  const rows = (await c.query("SELECT * FROM policies WHERE is_current ORDER BY created_at, stable_id FOR UPDATE")).rows as PolRow[];
  return rows.filter((r) => isIn(r.kind, aliases));
}

/** Regra 3: tenant fora do pack publica alçada → industry_pack='generic' + policy_kinds.alcada ← aliases do generic (resto intacto). */
async function switchToGeneric(c: Client, ctx: Ctx, kinds: EffectivePolicyKinds, from: string | null, why: string, via: string) {
  const next = toStored({ ...kinds, alcada: [...genericAliases()] });
  await c.query("UPDATE tenant_settings SET industry_pack = $1, policy_kinds = $2::jsonb, updated_at = now()",
    [GENERIC, JSON.stringify(next)]);
  await audit(c, ctx, "update", "tenant_settings", ctx.tenantId, { why, action: "pack_switch", from, to: GENERIC, via });
  return { from, to: GENERIC as typeof GENERIC };
}

async function newVersion(c: Client, ctx: Ctx, prev: PolRow, body: unknown, why: string): Promise<PolRow> {
  await c.query("UPDATE policies SET is_current = false WHERE id = $1", [prev.id]);
  const ins = (await c.query(
    `INSERT INTO policies (stable_id, tenant_id, kind, name, body, version, is_current, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, true, $7) RETURNING *`,
    [prev.stable_id, ctx.tenantId, prev.kind, prev.name, JSON.stringify(body), Number(prev.version) + 1, ctx.userId])).rows[0] as PolRow;
  await audit(c, ctx, "update", "policies", ins.id, { why, stable_id: prev.stable_id, previous_id: prev.id,
    previous_version: prev.version, version: ins.version, changes: { body } });
  return ins;
}

/** Cria a POL; se já houve (kind,name) retirada, revive a identidade como versão nova (UNIQUE tenant,kind,name,version). */
async function createOrRevive(c: Client, ctx: Ctx, kind: string, name: string, body: unknown, why: string): Promise<PolRow> {
  const old = (await c.query("SELECT stable_id, max(version)::int AS v FROM policies WHERE kind = $1 AND name = $2 GROUP BY stable_id ORDER BY 2 DESC LIMIT 1",
    [kind, name])).rows[0];
  const sid = old ? String(old.stable_id) : randomUUID();
  const version = old ? Number(old.v) + 1 : 1;
  const ins = (await c.query(
    `INSERT INTO policies (id, stable_id, tenant_id, kind, name, body, version, is_current, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, true, $8) RETURNING *`,
    [old ? randomUUID() : sid, sid, ctx.tenantId, kind, name, JSON.stringify(body), version, ctx.userId])).rows[0] as PolRow;
  await audit(c, ctx, "create", "policies", ins.id, { why, version, stable_id: sid, revived: !!old, data: { kind, name, body } });
  return ins;
}

async function retire(c: Client, ctx: Ctx, rows: PolRow[], why: string) {
  for (const r of rows) {
    await c.query("UPDATE policies SET is_current = false WHERE id = $1", [r.id]);
    await audit(c, ctx, "retire", "policies", r.id, { why, stable_id: r.stable_id, version: r.version, reason: "pack_without_alcada" });
  }
}

const packOf = (id: unknown) => (typeof id === "string" && getPack(id)) || genericPack();

/** PUT /api/cadastro/alcada — upsert da POL corrente (nova versão | cria/revive); fora do pack → switch p/ generic. */
export async function upsertAlcada(c: Client, ctx: Ctx, limitMi: number | null, why: string) {
  await lockTenant(c, ctx.tenantId);
  const { row, kinds } = await tenantKinds(c);
  let packSwitched: { from: string | null; to: "generic" } | null = null;
  if (kinds.alcada === null) {
    packSwitched = await switchToGeneric(c, ctx, kinds, (row?.industry_pack as string | null) ?? null, why, "PUT /api/cadastro/alcada");
    kinds.alcada = [...genericAliases()];
  }
  const cur = await currentAlcada(c, kinds.alcada);
  if (cur.length > 1) throw new HttpError(409, "alcada_ambiguous", { ids: cur.map((r) => r.stable_id), hint: "retire as extras (V0 = 1 POL)" });
  if (cur.length === 1) {
    const prevBody = cur[0].body && typeof cur[0].body === "object" && !Array.isArray(cur[0].body) ? cur[0].body as object : {};
    return { policy: await newVersion(c, ctx, cur[0], { ...prevBody, limitMi }, why), action: "updated" as const, packSwitched };
  }
  const pack = packOf(packSwitched ? GENERIC : row?.industry_pack);
  const name = (pack.alcada ?? genericPack().alcada!).name;
  return { policy: await createOrRevive(c, ctx, kinds.alcada[0], name, { limitMi }, why), action: "created" as const, packSwitched };
}

/** Regra 2: efeito da troca de pack na POL de alçada. `prevKinds` = vocabulário ANTES da troca. */
export async function applyPackAlcada(c: Client, ctx: Ctx, prevKinds: EffectivePolicyKinds, pack: PackProfile, why: string) {
  const detect = [...new Set([...(prevKinds.alcada ?? []), ...(pack.policy_kinds.alcada ?? []), ...genericAliases()])];
  const cur = await currentAlcada(c, detect);
  if (pack.policy_kinds.alcada && pack.alcada) {
    if (cur.length) return { action: "kept" as const, policyIds: cur.map((r) => r.stable_id) };
    const p = await createOrRevive(c, ctx, pack.policy_kinds.alcada[0], pack.alcada.name, { limitMi: pack.alcada.defaultLimitMi }, why);
    return { action: "created" as const, policyIds: [p.stable_id] };
  }
  if (!cur.length) return { action: "none" as const, policyIds: [] };
  await retire(c, ctx, cur, why);
  return { action: "retired" as const, policyIds: cur.map((r) => r.stable_id) };
}

const bodyLimit = (body: unknown) => {
  if (body && typeof body === "object" && !Array.isArray(body) && "limitMi" in body) validateLimitMi((body as { limitMi: unknown }).limitMi);
};

/** POST /api/policies: kind de alçada → valida limitMi; fora do pack → switch p/ generic; já existe → 409 alcada_exists. */
export async function beforePolicyCreate(c: Client, ctx: Ctx, data: { kind?: unknown; body?: unknown }, why: string | null) {
  await lockTenant(c, ctx.tenantId);
  const { row, kinds } = await tenantKinds(c);
  if (!isIn(String(data.kind ?? ""), kinds.alcada ?? genericAliases())) return null;
  bodyLimit(data.body);
  let packSwitched: { from: string | null; to: "generic" } | null = null;
  if (kinds.alcada === null) {
    packSwitched = await switchToGeneric(c, ctx, kinds, (row?.industry_pack as string | null) ?? null, why ?? "publicar alçada (POST /api/policies)", "POST /api/policies");
    kinds.alcada = [...genericAliases()];
  }
  const cur = await currentAlcada(c, kinds.alcada);
  if (cur.length) throw new HttpError(409, "alcada_exists", { id: cur[0].stable_id, hint: "PUT /api/cadastro/alcada" });
  return packSwitched;
}

/** PATCH /api/policies/:id de POL de alçada: limitMi estrito (kind é business key imutável no CRUD genérico). */
export async function beforePolicyPatch(c: Client, ctx: Ctx, prev: { kind: string }, patch: { body?: unknown }) {
  await lockTenant(c, ctx.tenantId);
  const { kinds } = await tenantKinds(c);
  if (kinds.alcada && isIn(prev.kind, kinds.alcada) && "body" in patch) bodyLimit(patch.body);
}

/** DELETE /api/policies/:id: última POL de alçada em pack com alçada → 409 alcada_required_in_pack. */
export async function beforePolicyRetire(c: Client, ctx: Ctx, id: string) {
  await lockTenant(c, ctx.tenantId);
  const { row, kinds } = await tenantKinds(c);
  if (!kinds.alcada) return;
  const target = (await c.query("SELECT kind FROM policies WHERE id = $1 AND is_current", [id])).rows[0];
  if (!target || !isIn(String(target.kind), kinds.alcada)) return;
  const cur = await currentAlcada(c, kinds.alcada);
  if (cur.length <= 1) throw new HttpError(409, "alcada_required_in_pack", { pack: (row?.industry_pack as string | null) ?? null,
    hint: "limpar = PUT /api/cadastro/alcada {limitMi:null}; tirar a alçada = POST /api/cadastro/pack (pack sem alçada)" });
}
