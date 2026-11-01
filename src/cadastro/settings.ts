/**
 * W3b · Task 9 — tenant_settings estendido (0013): validação dos overrides do PUT, visão do GET (com `alcada` derivado),
 * aplicação de pack (Regra 1) e lock por tenant. Sem IA generativa, sem rede. Contrato: docs/architecture/W3B-CADASTRO-WRITE-API-CONTRACT.md.
 */
import { z } from "zod";
import type { Client } from "../db/pool.js";
import type { Ctx } from "../http/common.js";
import { audit } from "../http/common.js";
import { HttpError } from "../http/errors.js";
import {
  KIND_GROUPS, type KindGroup, type StoredPolicyKinds, effectivePolicyKinds, normalizeKind, toStored,
} from "../domain/policy-kinds.js";
import { loadAlcadaPolicy } from "../w3/alcada.js";
import { AGENT_KEYS, type PackProfile } from "./packs.js";

/** pg_advisory_xact_lock(tenant): serializa escritas de cadastro (pack/alçada/settings) do tenant na tx corrente. */
export async function lockTenant(c: Client, tenantId: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtext('ibp_cadastro:' || $1))", [tenantId]);
}

const label = z.string().trim().min(1).max(40);
const labelsSchema = z.object({
  node: label, capacity: label, route: label, sku: label, contract: label, capacity_uom: label.optional(),
}).strict();
export type EntityLabels = z.infer<typeof labelsSchema>;

export function validateEntityLabels(v: unknown): EntityLabels {
  const r = labelsSchema.safeParse(v);
  if (!r.success) throw new HttpError(400, "invalid_labels", { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  return r.data;
}

const agentSchema = (k: string) => z.object({
  enabled: z.boolean(),
  ...(k === "A4" ? { solver: z.literal("cbc").optional() } : {}),
  ...(k === "A7" ? { mode: z.literal("state_machine_only").optional() } : {}),
}).strict();
const rosterSchema = z.object(Object.fromEntries(AGENT_KEYS.map((k) => [k, agentSchema(k).optional()]))).strict();
export type AgentRoster = Record<string, { enabled: boolean; solver?: "cbc"; mode?: "state_machine_only" }>;

/** Override parcial do roster (chaves ⊂ A1..A7). A4.solver só "cbc"; A7.mode só "state_machine_only" (gate: solver pago / IA generativa). */
export function validateAgentRoster(v: unknown): AgentRoster {
  const r = rosterSchema.safeParse(v);
  if (!r.success) throw new HttpError(400, "invalid_agent_roster", { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  return Object.fromEntries(Object.entries(r.data).filter(([, x]) => x !== undefined)) as AgentRoster;
}

/**
 * Merge por chave de topo sobre o vocabulário EFETIVO (tenant legado `{}` materializa o legado, incl. alcada).
 * Chave `alcada` só pode trocar aliases (não adicionar nem remover: pack-inclui-alçada muda via POST /pack ou Regra 3).
 */
export function mergePolicyKinds(stored: unknown, patch: unknown): StoredPolicyKinds {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "invalid_policy_kinds", { reason: "must be an object" });
  const base = toStored(effectivePolicyKinds(stored));
  const out: StoredPolicyKinds = { ...base };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(KIND_GROUPS as readonly string[]).includes(k)) throw new HttpError(400, "invalid_policy_kinds", { key: k, allowed: KIND_GROUPS });
    if (k === "alcada" && (!base.alcada || v === null || (Array.isArray(v) && !v.length)))
      throw new HttpError(400, "use_pack_endpoint", { field: "policy_kinds.alcada", hint: "POST /api/cadastro/pack ou PUT /api/cadastro/alcada" });
    if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string" || !normalizeKind(x)))
      throw new HttpError(400, "invalid_policy_kinds", { key: k, reason: "non-empty array of non-empty strings" });
    out[k as KindGroup] = [...new Set((v as string[]).map(normalizeKind))];
  }
  const seen = new Map<string, string>();
  for (const [g, list] of Object.entries(out)) for (const a of list ?? []) {
    const prev = seen.get(a);
    if (prev && prev !== g) throw new HttpError(400, "ambiguous_policy_kind", { alias: a, keys: [prev, g] });
    seen.set(a, g);
  }
  return out;
}

export const settingsDefaults = (tenantId: string) => ({
  tenant_id: tenantId, currency: null, uom: null, node_types: [] as string[], kpi_labels: {}, supply_external_in_scope: false,
  confirmed_at: null, industry_pack: null, entity_labels: {}, policy_kinds: {}, agent_roster: {},
});

export async function readSettingsRow(c: Client): Promise<Record<string, unknown> | undefined> {
  return (await c.query("SELECT * FROM tenant_settings")).rows[0];
}

/** GET /api/tenant-settings: linha (ou defaults) + derivado `alcada {inPack, mode, policy}` (mesma resolução da Task 8). */
export async function settingsView(c: Client, tenantId: string) {
  const row = (await readSettingsRow(c)) ?? settingsDefaults(tenantId);
  const kinds = effectivePolicyKinds(row.policy_kinds);
  const { mode, policy } = await loadAlcadaPolicy(c);
  return { ...row, policy_kinds_effective: kinds, alcada: { inPack: kinds.alcada !== null, mode, policy } };
}

/** Regra 1 (applyPack do wire): sobrescreve labels/policy_kinds/roster/kpi_labels/uom; node_types = pack ∪ em uso; currency e confirmed_at intactos. */
export async function writePack(c: Client, ctx: Ctx, pack: PackProfile, why: string, from: string | null) {
  const inUse = (await c.query("SELECT DISTINCT node_type FROM nodes WHERE is_current AND node_type IS NOT NULL ORDER BY node_type")).rows
    .map((r) => String(r.node_type));
  const nodeTypes = [...new Set([...pack.node_types, ...inUse])];
  const agents = pack.agents as AgentRoster;
  await c.query(
    `INSERT INTO tenant_settings (tenant_id, industry_pack, entity_labels, policy_kinds, agent_roster, kpi_labels, uom, node_types, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8::text[], now())
     ON CONFLICT (tenant_id) DO UPDATE SET industry_pack = EXCLUDED.industry_pack, entity_labels = EXCLUDED.entity_labels,
       policy_kinds = EXCLUDED.policy_kinds, agent_roster = EXCLUDED.agent_roster, kpi_labels = EXCLUDED.kpi_labels,
       uom = EXCLUDED.uom, node_types = EXCLUDED.node_types, updated_at = now()`,
    [ctx.tenantId, pack.profile_id, JSON.stringify(pack.labels), JSON.stringify(pack.policy_kinds), JSON.stringify(agents),
     JSON.stringify(pack.kpi_labels), pack.uom, nodeTypes]);
  await audit(c, ctx, "update", "tenant_settings", ctx.tenantId,
    { why, action: "apply_pack", from, to: pack.profile_id, node_types_kept_in_use: inUse.filter((t) => !pack.node_types.includes(t)) });
}
