/**
 * W1b — Prontidão do cadastro para o A4 (espelha o checklist do wire shell v0.3.1).
 * Item: ok | falta | n/a. "publicado" = versão corrente (is_current). Sem solver/LLM aqui — só leitura do cadastro.
 *
 * Ordem canônica (coach B · wire v0.3.10 · docs/architecture/COACH-B-READINESS-DELTA.md §1): mestres antes de política.
 * Consumidores leem items POR `key`, nunca por índice.
 * 1. node_capacity   — ≥1 nó corrente com node_capacity corrente (JOIN por stable_id; capacity_per_period > 0).
 *                      Capacidade vem de node_capacity, nunca de campo no nó.
 * 2. sku             — ≥1 SKU corrente (skus.is_current). Sem migration. (v0.3.10)
 * 3. route           — ≥1 rota corrente.
 * 4. supplier_contract — ≥1 contrato corrente, exigido só se tenant_settings.supply_external_in_scope; senão n/a.
 * 5. policy          — política de capital de giro corrente, OU (estoque + serviço) correntes.
 *                      policies.kind é texto livre (0005): normalizado (minúsculas, sem acento, espaço/hífen → "_")
 *                      e comparado ao vocabulário do tenant (tenant_settings.policy_kinds, W3b/0013; {} → legado POLICY_KINDS).
 * Alçada (POL-04) NÃO é item A4 — fica no gate canStart do coach (UX).
 * pct = itens exigidos ok ÷ itens exigidos. (tenant_settings.confirmed_at — unlock Didi v0.3.2 — ainda não existe.)
 * state (wire v0.3.1 readiness()): block se falta item exigido; warn se todos ok mas há restrições
 *   (nó corrente sem capacidade corrente; Gap card aberto status=gap; W6: policy kind fora do vocabulário); ok caso contrário.
 */
import type { PoolClient } from "pg";
import {
  type EffectivePolicyKinds, LEGACY_POLICY_KINDS, POLICY_KIND_UNKNOWN_WHY, effectivePolicyKinds, inKindGroup, isKnownKind, normalizeKind,
} from "./policy-kinds.js";

export type ItemStatus = "ok" | "falta" | "n/a";
export type ReadinessKey = "node_capacity" | "sku" | "route" | "supplier_contract" | "policy";
/** Ordem canônica dos items (coach B · v0.3.10). */
export const READINESS_ORDER: readonly ReadinessKey[] = ["node_capacity", "sku", "route", "supplier_contract", "policy"];

export interface ReadinessItem {
  key: ReadinessKey;
  status: ItemStatus;
  required: boolean;
  label: string;
  rule: string;
  /** stable_ids que satisfazem o item (para drill/link na UI) */
  by: string[];
  /** entidade de cadastro onde se resolve o item */
  entity: "policies" | "node_capacity" | "skus" | "routes" | "supplier_contracts";
}

export type ReadinessWarningKind = "node_without_capacity" | "open_gap_card" | "policy_kind_unknown";
/** why: só em policy_kind_unknown (W6 · Task 12) — por que o item não conta para o A4. */
export interface ReadinessWarning { kind: ReadinessWarningKind; label: string; by: string[]; why?: string }

export interface A4Readiness {
  state: "ok" | "warn" | "block";
  label: string;
  met: number;
  need: number;
  pct: number;
  items: ReadinessItem[];
  warnings: ReadinessWarning[];
  scope: { supply_external_in_scope: boolean };
}

/** Chaves canônicas (normalizadas) legadas para policies.kind (W3b: o tenant pode ter as suas em tenant_settings.policy_kinds). */
export const POLICY_KINDS = {
  working_capital: LEGACY_POLICY_KINDS.working_capital,
  inventory: LEGACY_POLICY_KINDS.inventory,
  service: LEGACY_POLICY_KINDS.service,
} as const;
export { normalizeKind };

export interface ReadinessFacts {
  policies: { stable_id: string; kind: string }[];
  nodesWithCapacity: string[]; // node stable_ids
  /** SKUs correntes (stable_ids) — item "sku" (coach B · v0.3.10) */
  skus: string[];
  routes: string[];
  contracts: string[];
  supplyExternalInScope: boolean;
  /** nós correntes sem node_capacity corrente > 0 (stable_ids) */
  nodesWithoutCapacity?: string[];
  /** premise_cards type=Gap status=gap (ids) */
  openGapCards?: string[];
  /** rótulo do KPI de capital de giro do tenant (tenant_settings.kpi_labels.wc), se houver */
  wcLabel?: string | null;
  /** W3b: vocabulário do tenant (tenant_settings.policy_kinds; {} → legado). Ausente → legado. */
  policyKinds?: EffectivePolicyKinds;
}

/** Função pura: fatos do cadastro → checklist tipado. */
export function computeReadiness(f: ReadinessFacts): A4Readiness {
  const kinds = f.policyKinds ?? effectivePolicyKinds({});
  const wc = f.policies.filter((p) => inKindGroup(kinds, p.kind, "working_capital"));
  const inv = f.policies.filter((p) => inKindGroup(kinds, p.kind, "inventory"));
  const svc = f.policies.filter((p) => inKindGroup(kinds, p.kind, "service"));
  const polOk = wc.length > 0 || (inv.length > 0 && svc.length > 0);
  const wcName = f.wcLabel?.trim() || "capital de giro";
  const st = (required: boolean, ok: boolean): ItemStatus => (!required ? "n/a" : ok ? "ok" : "falta");

  const items: ReadinessItem[] = [
    {
      key: "node_capacity", entity: "node_capacity", required: true, status: st(true, f.nodesWithCapacity.length > 0),
      label: "≥ 1 nó publicado com capacidade",
      rule: "nó corrente com node_capacity corrente (capacity_per_period > 0)",
      by: f.nodesWithCapacity,
    },
    {
      key: "sku", entity: "skus", required: true, status: st(true, f.skus.length > 0),
      label: "≥ 1 SKU publicado (Produtos)", rule: "skus corrente (is_current)", by: f.skus,
    },
    {
      key: "route", entity: "routes", required: true, status: st(true, f.routes.length > 0),
      label: "≥ 1 rota publicada", rule: "routes corrente", by: f.routes,
    },
    {
      key: "supplier_contract", entity: "supplier_contracts", required: f.supplyExternalInScope,
      status: st(f.supplyExternalInScope, f.contracts.length > 0),
      label: "≥ 1 contrato de fornecedor publicado",
      rule: "Exigido só se supply externo (compra de terceiros) estiver no escopo do tenant (tenant_settings.supply_external_in_scope).",
      by: f.contracts,
    },
    {
      key: "policy", entity: "policies", required: true, status: st(true, polOk),
      label: `Política de ${wcName} (ou Estoque + Serviço) publicada`,
      rule: `policies.kind corrente ∈ {${kinds.working_capital.join(", ")}} ou (estoque + serviço)`,
      by: (wc.length ? wc : inv.concat(svc)).map((p) => p.stable_id),
    },
  ];
  const need = items.filter((i) => i.required).length;
  const met = items.filter((i) => i.required && i.status === "ok").length;
  const warnings: ReadinessWarning[] = [];
  if (f.nodesWithoutCapacity?.length)
    warnings.push({ kind: "node_without_capacity", label: "Nó publicado sem capacidade corrente", by: f.nodesWithoutCapacity });
  if (f.openGapCards?.length)
    warnings.push({ kind: "open_gap_card", label: "Gap card aberto", by: f.openGapCards });
  // W6 · Task 12: kind ∉ vocabulário do tenant segue FORA da política (F-1) — só fica visível (warn, nunca block).
  const unknown = f.policies.filter((p) => !isKnownKind(kinds, p.kind));
  if (unknown.length) {
    const ks = [...new Set(unknown.map((p) => normalizeKind(p.kind)))];
    warnings.push({ kind: "policy_kind_unknown", label: `Política com kind fora do vocabulário: ${ks.join(", ")}`,
      by: unknown.map((p) => p.stable_id), why: POLICY_KIND_UNKNOWN_WHY });
  }
  const state = met < need ? "block" : warnings.length ? "warn" : "ok";
  const label = { block: "A4 bloqueado", warn: "A4 pronto c/ restrições", ok: "A4 pronto" }[state];
  return {
    state, label, met, need, pct: need ? Math.round((100 * met) / need) : 0,
    items, warnings, scope: { supply_external_in_scope: f.supplyExternalInScope },
  };
}

/** Lê os fatos sob RLS (client já com app.tenant_id). */
export async function loadReadinessFacts(c: PoolClient): Promise<ReadinessFacts> {
  // sequencial: um client pg não executa queries em paralelo
  const pol = await c.query("SELECT stable_id, kind FROM policies WHERE is_current ORDER BY kind, name");
  const nodes = await c.query(`SELECT DISTINCT n.stable_id FROM nodes n
      JOIN node_capacity nc ON nc.tenant_id = n.tenant_id AND nc.node_id = n.stable_id AND nc.is_current
     WHERE n.is_current AND nc.capacity_t_month > 0 ORDER BY n.stable_id`);
  const noCap = await c.query(`SELECT n.stable_id FROM nodes n WHERE n.is_current AND NOT EXISTS (
      SELECT 1 FROM node_capacity nc WHERE nc.tenant_id = n.tenant_id AND nc.node_id = n.stable_id
         AND nc.is_current AND nc.capacity_t_month > 0) ORDER BY n.code`);
  const gaps = await c.query("SELECT id FROM premise_cards WHERE type = 'Gap' AND status = 'gap' ORDER BY created_at");
  const skus = await c.query("SELECT stable_id FROM skus WHERE is_current ORDER BY code");
  const routes = await c.query("SELECT stable_id FROM routes WHERE is_current ORDER BY code");
  const contracts = await c.query("SELECT stable_id FROM supplier_contracts WHERE is_current ORDER BY code");
  const settings = await c.query("SELECT supply_external_in_scope, kpi_labels, policy_kinds FROM tenant_settings");
  const s = settings.rows[0];
  return {
    policies: pol.rows,
    nodesWithCapacity: nodes.rows.map((r) => r.stable_id),
    nodesWithoutCapacity: noCap.rows.map((r) => r.stable_id),
    openGapCards: gaps.rows.map((r) => r.id),
    skus: skus.rows.map((r) => r.stable_id),
    routes: routes.rows.map((r) => r.stable_id),
    contracts: contracts.rows.map((r) => r.stable_id),
    supplyExternalInScope: Boolean(s?.supply_external_in_scope),
    wcLabel: (s?.kpi_labels?.wc as string | undefined) ?? null,
    policyKinds: effectivePolicyKinds(s?.policy_kinds ?? {}),
  };
}
