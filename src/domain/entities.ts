/**
 * Registry de entidades de cadastro W0. Colunas = exatamente as de contracts/v0-postgres-cadastro.sql.
 * Nada de cenário/runtime aqui (DENY W0).
 */
import { z } from "zod";

const uuid = z.uuid();
const json = z.record(z.string(), z.unknown());
const num = z.number().finite();
const date = z.iso.date();
/** Mês YYYY-MM (T-DM-PERIOD-GRAIN) — idêntico ao CHECK sales_history_period_ym (0018). Rejeita dia (YYYY-MM-DD). */
export const YM_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
export const ym = z.string().regex(YM_RE, "YYYY-MM (só mês)");

/** Referência a outra entidade versionada: o valor é o `stable_id` (identidade entre versões), nunca o id da linha-versão. */
export type RefCheck = { field: string; table: "nodes" | "skus"; many?: boolean };

export interface EntityDef {
  /** path REST e nome da tabela */
  path: string;
  table: string;
  /** colunas graváveis pela API (subset das colunas do SQL) */
  schema: z.ZodObject<z.ZodRawShape>;
  /** versionada (version + is_current)? */
  versioned: boolean;
  /** chave de negócio que identifica a "mesma entidade" entre versões */
  businessKey: string[];
  /** FKs a validar sob RLS (impede referenciar id de outro tenant) */
  refs?: RefCheck[];
  /**
   * Aliases agnósticos da API → coluna do contrato SQL (W0.1; rename SQL só na W0.2 com PR do Arquiteto).
   * Entrada aceita o alias (preferido) ou a coluna legada; saída devolve só o alias.
   * Unidade/moeda NÃO estão no nome: vêm de tenant_settings.uom / tenant_settings.currency.
   */
  aliases?: Record<string, string>;
  /** grava created_by com o usuário do request */
  hasCreatedBy?: boolean;
  orderBy: string;
}

export const entities: EntityDef[] = [
  {
    path: "policies", table: "policies", versioned: true, businessKey: ["kind", "name"], hasCreatedBy: true,
    orderBy: "kind, name, version",
    schema: z.object({
      kind: z.string().trim().min(1), // texto livre (migration 0005); sem enum de vertical
      name: z.string().min(1),
      body: json.optional(),
    }),
  },
  {
    path: "nodes", table: "nodes", versioned: true, businessKey: ["code"], orderBy: "code, version",
    schema: z.object({
      code: z.string().min(1),
      name: z.string().min(1),
      node_type: z.string().trim().min(1), // validado na API contra tenant_settings.node_types (se não vazio)
      attrs: json.optional(),
    }),
  },
  {
    path: "node_capacity", table: "node_capacity", versioned: true, businessKey: ["node_id"],
    orderBy: "node_id, version", refs: [{ field: "node_id", table: "nodes" }],
    aliases: { capacity_per_period: "capacity_t_month" },
    schema: z.object({
      node_id: uuid,
      capacity_t_month: num.nullable().optional(), // coluna do contrato; API expõe como capacity_per_period (uom = tenant_settings.uom)
      capacity_extra: num.nullable().optional(),
      calendar: json.optional(),
    }),
  },
  {
    path: "routes", table: "routes", versioned: true, businessKey: ["code"], orderBy: "code, version",
    refs: [{ field: "origin_node_id", table: "nodes" }, { field: "dest_node_id", table: "nodes" }],
    aliases: { cost_per_unit: "cost_per_ton" },
    schema: z.object({
      code: z.string().min(1),
      origin_node_id: uuid,
      dest_node_id: uuid,
      mode: z.string().nullable().optional(),
      lead_time_days: num.nullable().optional(),
      cost_per_ton: num.nullable().optional(), // coluna do contrato; API expõe como cost_per_unit (moeda/uom = tenant_settings)
      windows: z.array(z.unknown()).optional(),
    }),
  },
  {
    path: "skus", table: "skus", versioned: true, businessKey: ["code"], orderBy: "code, version",
    schema: z.object({
      code: z.string().min(1),
      name: z.string().min(1),
      family: z.string().nullable().optional(),
      unit_cost: num.nullable().optional(),
      attrs: json.optional(),
    }),
  },
  {
    path: "supplier_contracts", table: "supplier_contracts", versioned: true, businessKey: ["code"],
    orderBy: "code, version", refs: [{ field: "sku_ids", table: "skus", many: true }],
    schema: z.object({
      code: z.string().min(1),
      supplier_group: z.string().min(1),
      obligations: json.optional(),
      sku_ids: z.array(uuid).optional(),
      valid_from: date.nullable().optional(),
      valid_to: date.nullable().optional(),
    }),
  },
  {
    // um mapeamento corrente por tenant
    path: "finance_drivers", table: "finance_drivers", versioned: true, businessKey: [], orderBy: "version",
    schema: z.object({ mapping: json }),
  },
  {
    // ingest/leitura; não versionado no contrato
    path: "sales_history", table: "sales_history", versioned: false, businessKey: [],
    orderBy: "period, node_id, sku_id",
    refs: [{ field: "node_id", table: "nodes" }, { field: "sku_id", table: "skus" }],
    schema: z.object({
      node_id: uuid,
      sku_id: uuid,
      period: ym,
      qty: num.min(0), // CHECK sales_history_qty_nonneg (0018)
      revenue: num.nullable().optional(),
      source: z.string().min(1).optional(), // UNIQUE (tenant_id,node_id,sku_id,period,source) — reimport → 409
    }),
  },
];

export const entityByPath = new Map(entities.map((e) => [e.path, e]));

/** colunas JSON que precisam de JSON.stringify para o driver pg */
export const jsonColumns = new Set(["body", "attrs", "calendar", "windows", "obligations", "mapping"]);

/** Entrada da API → colunas do contrato. Rejeita alias + coluna legada com valores diferentes. */
export function aliasIn(def: EntityDef, body: Record<string, unknown>): Record<string, unknown> {
  if (!def.aliases || body === null || typeof body !== "object") return body;
  const out = { ...body };
  for (const [alias, col] of Object.entries(def.aliases)) {
    if (!(alias in out)) continue;
    if (col in out && out[col] !== out[alias]) throw new AliasConflict(alias, col);
    out[col] = out[alias];
    delete out[alias];
  }
  return out;
}

/** Linha do banco → resposta da API (coluna legada some; só o alias). */
export function aliasOut(def: EntityDef, row: Record<string, unknown>): Record<string, unknown> {
  if (!def.aliases || !row) return row;
  const out: Record<string, unknown> = {};
  const byCol = new Map(Object.entries(def.aliases).map(([a, c]) => [c, a]));
  for (const [k, v] of Object.entries(row)) out[byCol.get(k) ?? k] = v;
  return out;
}

/** Campos expostos pela API (aliases no lugar das colunas). */
export function apiFields(def: EntityDef): string[] {
  const byCol = new Map(Object.entries(def.aliases ?? {}).map(([a, c]) => [c, a]));
  return Object.keys(def.schema.shape).map((k) => byCol.get(k) ?? k);
}

export class AliasConflict extends Error {
  constructor(public alias: string, public column: string) { super(`alias_conflict: ${alias} vs ${column}`); }
}
