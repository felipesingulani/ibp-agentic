/**
 * W7 · Task 13 — contrato do export do plano aprovado (docs/architecture/W7-PLAN-EXPORT-CONTRACT.md).
 * Papéis/formatos cravados PO; ajv runtime na saída JSON (padrão W4) contra contracts/plan-export.schema.json.
 */
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { HttpError } from "../http/errors.js";

export const EXPORT_VERSION = "w7.v0" as const;
export const EXPORT_ROLES = ["admin", "domain_owner", "finance"] as const; // cravo PO 3 (finance = leitura financeira)
export const EXPORT_FORMATS = ["json", "csv"] as const; // cravo PO 2
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** CSV longo (1 tabela, coluna `section`) — ordem fixa do contrato. */
export const CSV_COLUMNS = ["section", "metric", "node_id", "node_code", "route_id", "route_code", "sku_id", "sku_code",
  "qty", "used", "capacity", "pct", "value"] as const;
export const CSV_SECTIONS = ["total", "flow", "local", "unmet", "utilization"] as const;
export const TOTAL_METRICS = ["objective", "period", "solverStatus", "demand", "served", "unmet", "fillRate"] as const;

export const isExportRole = (role: string | null) => (EXPORT_ROLES as readonly string[]).includes(role ?? "");

/** `format` ausente/∉ {json,csv} (inclui repetido/array, case-sensitive) → 400 validation_failed {field:"format"}. */
export function parseExportFormat(v: unknown): ExportFormat {
  if (typeof v === "string" && (EXPORT_FORMATS as readonly string[]).includes(v)) return v as ExportFormat;
  throw new HttpError(400, "validation_failed", { field: "format", allowed: [...EXPORT_FORMATS] });
}

const ajv = new Ajv2020({ strict: false });
const validate = ajv.compile(JSON.parse(readFileSync(new URL("../../contracts/plan-export.schema.json", import.meta.url), "utf8")));

export function assertPlanExport(p: unknown): void {
  if (!validate(p)) throw new Error(`PlanExport fora do contrato: ${ajv.errorsText(validate.errors)}`);
}
