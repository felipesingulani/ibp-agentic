/**
 * W3b · Task 9 — registry de packs de indústria (packs/<id>/profile.json, espelho do PACKS do wire shell v0.3.5).
 * Lido SÓ na escrita (POST /api/cadastro/pack, switch p/ generic) e no GET /api/cadastro/packs; runtime lê tenant_settings.
 * Validação zod na carga (fail-fast). Enums agnósticos de indústria: o pack só muda rótulos/aliases/defaults.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { KIND_GROUPS, normalizeKind } from "../domain/policy-kinds.js";

const label = z.string().trim().min(1).max(40);
export const LABEL_KEYS = ["node", "capacity", "route", "sku", "contract"] as const;
export const AGENT_KEYS = ["A1", "A2", "A3", "A4", "A5", "A6", "A7"] as const;
const aliases = z.array(z.string().min(1)).min(1).transform((a) => [...new Set(a.map(normalizeKind))]);

const profileSchema = z.object({
  profile_id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  sim: z.boolean(),
  labels: z.object({ node: label, capacity: label, route: label, sku: label, contract: label, capacity_uom: label.optional() }).strict(),
  uom: z.string().min(1),
  node_types: z.array(z.string().min(1)).min(1),
  kpi_labels: z.record(z.string(), z.string()),
  policy_kinds: z.object({ working_capital: aliases, inventory: aliases, service: aliases, alcada: aliases.optional() }).strict(),
  /** T-BIZ-WC-V0 (AR-10): DSO/DPO/horizonte/dias — config do pack, não env. */
  finance: z.object({
    dso_days: z.number().finite().positive(),
    dpo_days: z.number().finite().nonnegative(),
    horizon_months: z.number().int().positive(),
    period_days: z.number().int().positive(),
  }).strict(),
  alcada: z.object({ defaultLimitMi: z.number().finite().min(0), name: z.string().min(1) }).strict().optional(),
  agents: z.object(Object.fromEntries(AGENT_KEYS.map((k) => [k, z.object({
    enabled: z.boolean(),
    ...(k === "A4" ? { solver: z.literal("cbc") } : {}),
    ...(k === "A7" ? { mode: z.literal("state_machine_only") } : {}),
  }).strict()]))).strict(),
}).strict().refine((p) => !!p.policy_kinds.alcada === !!p.alcada, { message: "policy_kinds.alcada ⇔ bloco alcada" });

export type PackProfile = z.infer<typeof profileSchema>;

function packsDir(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const rel of ["../../packs", "../../../packs"]) { const d = join(here, rel); if (existsSync(d)) return d; }
  throw new Error("packs/ dir not found");
}

let cache: Map<string, PackProfile> | null = null;
function registry(): Map<string, PackProfile> {
  if (cache) return cache;
  const dir = packsDir();
  const m = new Map<string, PackProfile>();
  for (const id of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const f = join(dir, id, "profile.json");
    if (!existsSync(f)) continue;
    const p = profileSchema.parse(JSON.parse(readFileSync(f, "utf8")));
    if (p.profile_id !== id) throw new Error(`packs/${id}: profile_id ${p.profile_id} ≠ pasta`);
    for (const [g, list] of Object.entries(p.policy_kinds)) {
      if (!(KIND_GROUPS as readonly string[]).includes(g)) throw new Error(`packs/${id}: grupo ${g}`);
      for (const [g2, l2] of Object.entries(p.policy_kinds)) if (g2 !== g && list!.some((a) => l2!.includes(a)))
        throw new Error(`packs/${id}: alias ambíguo entre ${g} e ${g2}`);
    }
    m.set(id, p);
  }
  return (cache = m);
}

export const getPack = (id: string): PackProfile | undefined => registry().get(id);
export const packIds = () => [...registry().keys()];
/** Pack de fallback (cravo PO 1: NULL ≡ generic; switch de PUT /cadastro/alcada fora do pack → generic). */
export const GENERIC = "generic";
export const genericPack = () => getPack(GENERIC)!;

/** GET /api/cadastro/packs — forma do contrato. */
export const listPacks = () => [...registry().values()].map((p) => ({
  id: p.profile_id, name: p.name, sim: p.sim, includesAlcada: !!p.policy_kinds.alcada,
  alcadaDefaultMi: p.alcada?.defaultLimitMi ?? null, labels: p.labels, policy_kinds: p.policy_kinds, agents: p.agents,
}));
