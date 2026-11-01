/**
 * W3b · Task 9 — vocabulário de policies.kind POR TENANT (tenant_settings.policy_kinds, migration 0013).
 * Fonte única p/ prontidão A4 (src/domain/a4Readiness.ts), alçada (src/w3/alcada.ts) e escrita de cadastro (src/cadastro/*).
 *
 * policy_kinds = {} (tenant legado, industry_pack NULL) ≡ generic → LEGACY_POLICY_KINDS, que INCLUI `alcada`
 *   (cravo PO 1: NULL ≡ generic ≡ pack com alçada → fail-closed se não houver POL).
 * policy_kinds ≠ {} → vale só o objeto do tenant; chave `alcada` ausente ⇒ alçada fora do pack (alcada = null).
 * Kinds comparados normalizados (minúsculas, sem acento, espaço/hífen → "_"). Sem LLM, sem rede.
 */
export const KIND_GROUPS = ["working_capital", "inventory", "service", "alcada"] as const;
export type KindGroup = (typeof KIND_GROUPS)[number];
export type StoredPolicyKinds = Partial<Record<KindGroup, string[]>>;
export interface EffectivePolicyKinds {
  working_capital: string[]; inventory: string[]; service: string[];
  /** null ⇒ pack do tenant não inclui alçada (out_of_pack) */
  alcada: string[] | null;
}

/** Vocabulário legado (pré-0013, = POLICY_KINDS do W1b + `alcada` do Task 8). */
export const LEGACY_POLICY_KINDS = {
  working_capital: ["working_capital", "capital_de_giro", "wc"],
  inventory: ["inventory", "estoque", "stock"],
  service: ["service", "servico", "service_level", "nivel_de_servico"],
  alcada: ["alcada"],
} as const;

export function normalizeKind(kind: string): string {
  return kind.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

const norm = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map(normalizeKind).filter(Boolean))] : [];

export const isLegacyKinds = (raw: unknown) =>
  raw === null || raw === undefined || (typeof raw === "object" && !Array.isArray(raw) && !Object.keys(raw as object).length);

export function effectivePolicyKinds(raw: unknown): EffectivePolicyKinds {
  if (isLegacyKinds(raw)) {
    return { working_capital: [...LEGACY_POLICY_KINDS.working_capital], inventory: [...LEGACY_POLICY_KINDS.inventory],
      service: [...LEGACY_POLICY_KINDS.service], alcada: [...LEGACY_POLICY_KINDS.alcada] };
  }
  const o = raw as Record<string, unknown>;
  return { working_capital: norm(o.working_capital), inventory: norm(o.inventory), service: norm(o.service),
    alcada: "alcada" in o && Array.isArray(o.alcada) && o.alcada.length ? norm(o.alcada) : null };
}

/** Forma armazenável (sem nulls) do vocabulário efetivo. */
export function toStored(k: EffectivePolicyKinds): StoredPolicyKinds {
  const s: StoredPolicyKinds = { working_capital: k.working_capital, inventory: k.inventory, service: k.service };
  if (k.alcada) s.alcada = k.alcada;
  return s;
}

export const inKindGroup = (k: EffectivePolicyKinds, kind: string, group: KindGroup) =>
  (k[group] ?? []).includes(normalizeKind(kind));

/** W6 · Task 12 — kind conhecido ⇔ normalizado ∈ algum grupo efetivo do tenant (alcada null ⇒ fora do pack ⇒ não conta). */
export const isKnownKind = (k: EffectivePolicyKinds, kind: string) => KIND_GROUPS.some((g) => inKindGroup(k, kind, g));

export const POLICY_KIND_UNKNOWN_WHY = "kind não está em tenant_settings.policy_kinds; não alimenta A4";
export interface PolicyKindWarning { code: "policy_kind_unknown"; kind: string; why: string }

/**
 * W6 · Task 12 — warn (não bloqueia) p/ POST/PATCH /api/policies: kind fora do vocabulário deixa de ser silêncio.
 * Semântica F-1 intacta: o kind segue fora do paramsFrom/prontidão; aqui só fica visível. [] quando conhecido.
 */
export function policyKindWarnings(k: EffectivePolicyKinds, kind: string): PolicyKindWarning[] {
  return isKnownKind(k, kind) ? [] : [{ code: "policy_kind_unknown", kind: normalizeKind(kind), why: POLICY_KIND_UNKNOWN_WHY }];
}
