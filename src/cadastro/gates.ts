/**
 * T-BIZ-CAD-GATES (AR-07) — avaliador puro dos gates de cadastro.
 * Usado pelo hint de gates do cenário, pelo POST do run A4 e pelo POST da decisão.
 * Escopo vazio → global (fail-closed). Sem migration e sem chamada de rede.
 *
 * Nó só de demanda que já é destino de rota com origem capacitada não entra no check de
 * capacidade: o LP piloto atende esse nó por transferência (L1/L2). Nó citado em NovaFilial
 * ou Gap (FIL-RAO) continua block mesmo com rota.
 */
import type { Client } from "../db/pool.js";
import { computeReadiness, loadReadinessFacts } from "../domain/a4Readiness.js";

export const GATE_RULES = [
  "node_without_capacity",
  "contract_without_volume",
  "contract_out_of_validity",
  "sku_without_cost",
  "sku_without_price",
  "finance_driver_draft",
] as const;
export type GateRule = (typeof GATE_RULES)[number];
export type GateEntity = "node" | "contract" | "sku" | "finance_driver";
export type GateState = "ok" | "warn" | "block";

export interface GateItem {
  entity: GateEntity;
  stable_id: string;
  code: string;
  rule: GateRule;
  severity: "block" | "warn";
  cta: string;
}

export interface GateNode { stable_id: string; code: string; capacity: number | null }
export interface GateSku { stable_id: string; code: string; unit_cost: number | null; unit_price: number | null }
export interface GateContract {
  stable_id: string; code: string; sku_ids: string[];
  min_volume: number | null; max_volume: number | null;
  valid_from: string | null; valid_to: string | null;
}
export interface GatePremise { type: string; node_id: string | null; fields: Record<string, unknown> }
export interface GateFacts {
  period: string | null;
  nodes: GateNode[];
  skus: GateSku[];
  contracts: GateContract[];
  financeDrivers: { stable_id: string; mapping: unknown }[];
  premises: GatePremise[];
  demand: { node_id: string; sku_id: string; qty: number }[];
  /** destinos de rota corrente cuja origem tem capacidade corrente > 0 */
  servedByCapacitatedOrigin: string[];
}
export interface GateScope { nodes: string[]; skus: string[]; contracts: string[] }
export interface GateResult { state: GateState; items: GateItem[] }
export interface GateSeal { global: number; scenario: { blocks: number; warns: number } }
export interface ScenarioGates extends GateResult { seal: GateSeal }

const SEVERITY: Record<GateRule, "block" | "warn"> = {
  node_without_capacity: "block",
  contract_without_volume: "block",
  contract_out_of_validity: "block",
  sku_without_cost: "block",
  sku_without_price: "warn",
  finance_driver_draft: "warn",
};
const CTA_PATH: Record<GateEntity, string> = {
  node: "nodes", contract: "supplier_contracts", sku: "skus", finance_driver: "finance_drivers",
};
const PREMISE_NODE_TYPES = new Set(["NovaFilial", "Gap"]);

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const hasCap = (n: GateNode) => n.capacity !== null && n.capacity > 0;

function item(entity: GateEntity, stableId: string, code: string, rule: GateRule): GateItem {
  return { entity, stable_id: stableId, code, rule, severity: SEVERITY[rule], cta: `/cadastro/${CTA_PATH[entity]}/${stableId}` };
}

function sortItems(items: GateItem[]): GateItem[] {
  const rank = (r: GateRule) => GATE_RULES.indexOf(r);
  return [...items].sort((a, b) => rank(a.rule) - rank(b.rule) || a.code.localeCompare(b.code) || a.stable_id.localeCompare(b.stable_id));
}

/** Vigência cobre o período do run (mês inteiro se YYYY-MM; o dia se YYYY-MM-DD). Sem período → não cobre (fail-closed). */
export function validityCovers(period: string | null, from: string | null, to: string | null): boolean {
  if (!period || !from || !to) return false;
  const ym = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  let start: string, end: string;
  if (ym) {
    const last = new Date(Date.UTC(Number(ym[1]), Number(ym[2]), 0)).getUTCDate();
    start = `${ym[1]}-${ym[2]}-01`;
    end = `${ym[1]}-${ym[2]}-${String(last).padStart(2, "0")}`;
  } else if (/^\d{4}-\d{2}-\d{2}/.test(period)) {
    start = end = period.slice(0, 10);
  } else return false;
  return from.slice(0, 10) <= start && to.slice(0, 10) >= end;
}

function citedSkuIds(fields: Record<string, unknown>, skus: GateSku[]): string[] {
  const ids = new Set<string>();
  for (const key of ["skuId", "sku_id", "sku", "skuCode", "sku_code"]) {
    const v = fields[key];
    if (typeof v !== "string" || !v) continue;
    const hit = skus.find((s) => s.stable_id === v || s.code === v);
    if (hit) ids.add(hit.stable_id);
  }
  return [...ids];
}

function premiseValue(facts: GateFacts, skuId: string, keys: string[]): number | null {
  for (const p of facts.premises) {
    if (!citedSkuIds(p.fields, facts.skus).includes(skuId)) continue;
    for (const k of keys) {
      const n = num(p.fields[k]);
      if (n !== null) return n;
    }
  }
  return null;
}

interface DriverRow { code: string; status: string; regra: string }

function codeOf(row: Record<string, unknown>, fallback: string): string {
  for (const k of ["code", "id"]) if (typeof row[k] === "string" && (row[k] as string).trim()) return (row[k] as string).trim();
  return fallback;
}
function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
function looksLikeDriver(v: unknown): v is Record<string, unknown> {
  const o = asObj(v);
  return !!o && ("status" in o || "regra" in o);
}

/** mapping jsonb (objeto ou array) → linhas FD. Objeto legado `{ volume: "cash" }` não é driver. */
export function financeDriverRows(mapping: unknown): DriverRow[] {
  const out: DriverRow[] = [];
  const push = (fallback: string, row: Record<string, unknown>) => out.push({
    code: codeOf(row, fallback),
    status: typeof row.status === "string" ? row.status : "",
    regra: row.regra == null ? "" : String(row.regra),
  });
  if (Array.isArray(mapping)) {
    mapping.forEach((v, i) => { if (looksLikeDriver(v)) push(String(i), v); });
    return out;
  }
  const o = asObj(mapping);
  if (!o) return out;
  for (const k of ["items", "drivers", "rows", "mapping"]) {
    if (Array.isArray(o[k])) {
      (o[k] as unknown[]).forEach((v, i) => { if (looksLikeDriver(v)) push(String(i), v); });
      return out;
    }
  }
  const nested = Object.entries(o).filter(([, v]) => looksLikeDriver(v));
  if (nested.length) {
    for (const [k, v] of nested) push(k, v as Record<string, unknown>);
    return out;
  }
  if (looksLikeDriver(o)) push("FD", o);
  return out;
}

function premiseNodeIds(facts: GateFacts): Set<string> {
  const known = new Set(facts.nodes.map((n) => n.stable_id));
  const out = new Set<string>();
  for (const p of facts.premises) {
    if (!PREMISE_NODE_TYPES.has(p.type)) continue;
    if (p.node_id && known.has(p.node_id)) out.add(p.node_id);
    const f = p.fields.nodeId;
    if (typeof f === "string" && known.has(f)) out.add(f);
  }
  return out;
}

/** Escopo do cenário (AR-07). Vazio → o avaliador aplica o cadastro inteiro. */
export function resolveScope(facts: GateFacts): GateScope {
  const premiseNodes = premiseNodeIds(facts);
  const demandNodes = new Set(facts.demand.filter((d) => d.qty > 0).map((d) => d.node_id));
  const served = new Set(facts.servedByCapacitatedOrigin);
  const cited = new Set<string>();
  for (const p of facts.premises) for (const id of citedSkuIds(p.fields, facts.skus)) cited.add(id);
  if (premiseNodes.size === 0 && demandNodes.size === 0 && cited.size === 0) return { nodes: [], skus: [], contracts: [] };

  const nodes = new Set<string>(premiseNodes);
  for (const n of demandNodes) if (!served.has(n)) nodes.add(n);
  const universe = new Set<string>([...premiseNodes, ...demandNodes]);
  const skus = new Set<string>(cited);
  for (const d of facts.demand) if (d.qty > 0 && universe.has(d.node_id)) skus.add(d.sku_id);
  const contracts = facts.contracts.filter((c) => c.sku_ids.some((id) => skus.has(id))).map((c) => c.stable_id);
  return {
    nodes: [...nodes].sort(),
    skus: [...skus].sort(),
    contracts: [...contracts].sort(),
  };
}

function scopeEmpty(scope: GateScope): boolean {
  return scope.nodes.length === 0 && scope.skus.length === 0 && scope.contracts.length === 0;
}

/** Fatos + escopo → state e items. Escopo vazio avalia todo o cadastro (fail-closed). */
export function evaluateGates(facts: GateFacts, scope: GateScope): GateResult {
  const effective: GateScope = scopeEmpty(scope)
    ? { nodes: facts.nodes.map((n) => n.stable_id), skus: facts.skus.map((s) => s.stable_id), contracts: facts.contracts.map((c) => c.stable_id) }
    : scope;
  const nodeIds = new Set(effective.nodes);
  const skuIds = new Set(effective.skus);
  const contractIds = new Set(effective.contracts);
  const items: GateItem[] = [];

  for (const n of facts.nodes) {
    if (!nodeIds.has(n.stable_id) || hasCap(n)) continue;
    items.push(item("node", n.stable_id, n.code, "node_without_capacity"));
  }
  for (const c of facts.contracts) {
    if (!contractIds.has(c.stable_id)) continue;
    const vol = num(c.min_volume) !== null || num(c.max_volume) !== null;
    if (!vol) items.push(item("contract", c.stable_id, c.code, "contract_without_volume"));
    if (!validityCovers(facts.period, c.valid_from, c.valid_to)) items.push(item("contract", c.stable_id, c.code, "contract_out_of_validity"));
  }
  for (const s of facts.skus) {
    if (!skuIds.has(s.stable_id)) continue;
    if (num(s.unit_cost) === null && premiseValue(facts, s.stable_id, ["unitCost", "unit_cost"]) === null) {
      items.push(item("sku", s.stable_id, s.code, "sku_without_cost"));
    }
    if (num(s.unit_price) === null && premiseValue(facts, s.stable_id, ["unitPrice", "unit_price"]) === null) {
      items.push(item("sku", s.stable_id, s.code, "sku_without_price"));
    }
  }
  for (const fd of facts.financeDrivers) {
    for (const row of financeDriverRows(fd.mapping)) {
      if (row.status === "draft" || row.regra.trim() === "") {
        items.push(item("finance_driver", fd.stable_id, row.code, "finance_driver_draft"));
      }
    }
  }
  const sorted = sortItems(items);
  const state: GateState = sorted.some((i) => i.severity === "block") ? "block" : sorted.length ? "warn" : "ok";
  return { state, items: sorted };
}

export const CADASTRO_GATE_BLOCK = "cadastro_gate_block";
export const gateBlockBody = (items: GateItem[]) => ({ error: { code: CADASTRO_GATE_BLOCK, items } });

const isoDate = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${v.getUTCFullYear()}-${m}-${d}`;
  }
  return null;
};
const priceOf = (attrs: unknown): number | null => num(asObj(attrs)?.unit_price);

/** Lê fatos do cenário sob RLS (client já com app.tenant_id). */
export async function loadGateFacts(c: Client, scenarioId: string): Promise<GateFacts> {
  const period = (await c.query("SELECT max(period) AS p FROM sales_history")).rows[0].p as string | null;
  const demand = period ? (await c.query(
    `SELECT node_id, sku_id, sum(qty)::float8 AS qty FROM sales_history WHERE period = $1 GROUP BY node_id, sku_id HAVING sum(qty) > 0`,
    [period])).rows : [];
  const nodes = (await c.query(`SELECT n.stable_id, n.code, cap.capacity_t_month AS cap FROM nodes n
      LEFT JOIN LATERAL (
        SELECT capacity_t_month FROM node_capacity
         WHERE tenant_id = n.tenant_id AND node_id = n.stable_id AND is_current
         ORDER BY version DESC LIMIT 1
      ) cap ON true
     WHERE n.is_current ORDER BY n.code`)).rows;
  const skus = (await c.query("SELECT stable_id, code, unit_cost, attrs FROM skus WHERE is_current ORDER BY code")).rows;
  const contracts = (await c.query(
    "SELECT stable_id, code, sku_ids, obligations, valid_from, valid_to FROM supplier_contracts WHERE is_current ORDER BY code")).rows;
  const premises = (await c.query(
    "SELECT type, node_id, fields FROM premise_cards WHERE scenario_id = $1 ORDER BY card_id", [scenarioId])).rows;
  const finance = (await c.query("SELECT stable_id, mapping FROM finance_drivers WHERE is_current ORDER BY version")).rows;
  const served = (await c.query(`SELECT DISTINCT r.dest_node_id AS id FROM routes r
      JOIN node_capacity nc ON nc.tenant_id = r.tenant_id AND nc.node_id = r.origin_node_id AND nc.is_current AND nc.capacity_t_month > 0
     WHERE r.is_current`)).rows;
  return {
    period,
    nodes: nodes.map((r) => ({ stable_id: String(r.stable_id), code: String(r.code), capacity: num(r.cap) })),
    skus: skus.map((r) => ({ stable_id: String(r.stable_id), code: String(r.code), unit_cost: num(r.unit_cost), unit_price: priceOf(r.attrs) })),
    contracts: contracts.map((r) => {
      const o = asObj(r.obligations) ?? {};
      return {
        stable_id: String(r.stable_id), code: String(r.code),
        sku_ids: (r.sku_ids as string[] | null)?.map(String) ?? [],
        min_volume: num(o.min_volume), max_volume: num(o.max_volume),
        valid_from: isoDate(r.valid_from), valid_to: isoDate(r.valid_to),
      };
    }),
    financeDrivers: finance.map((r) => ({ stable_id: String(r.stable_id), mapping: r.mapping })),
    premises: premises.map((r) => ({
      type: String(r.type), node_id: r.node_id ? String(r.node_id) : null,
      fields: asObj(r.fields) ?? {},
    })),
    demand: demand.map((r) => ({ node_id: String(r.node_id), sku_id: String(r.sku_id), qty: Number(r.qty) })),
    servedByCapacitatedOrigin: served.map((r) => String(r.id)),
  };
}

export function sealOf(stateItems: GateItem[], readiness: { met: number; need: number }): GateSeal {
  return {
    global: readiness.need ? readiness.met / readiness.need : 1,
    scenario: {
      blocks: stateItems.filter((i) => i.severity === "block").length,
      warns: stateItems.filter((i) => i.severity === "warn").length,
    },
  };
}

/** Mesmo avaliador do POST e do GET. */
export async function loadScenarioGates(c: Client, scenarioId: string): Promise<ScenarioGates> {
  const facts = await loadGateFacts(c, scenarioId);
  const result = evaluateGates(facts, resolveScope(facts));
  const readiness = computeReadiness(await loadReadinessFacts(c));
  return { ...result, seal: sealOf(result.items, readiness) };
}
