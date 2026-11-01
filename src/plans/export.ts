/**
 * W7 · Task 13 — export do plano aprovado: JSON (a4_runs.plan cru − reasonCandidates) + CSV longo (projeção 1:1).
 * Read-only e determinístico: zero cálculo novo, zero default numérico, sem rede, sem arquivo em disco (stream da resposta).
 * Fonte única do plano vigente = resolvePlanRef (W3); basis ≠ approved → 409 no_approved_plan (nunca cai p/ latest_run).
 */
import type { Client } from "../db/pool.js";
import type { Row } from "../http/common.js";
import { HttpError } from "../http/errors.js";
import { type PlanRef, resolvePlanRef } from "../w3/plan-ref.js";
import { CSV_COLUMNS, EXPORT_VERSION, type ExportFormat, TOTAL_METRICS } from "./contract.js";

export interface PlanExport {
  exportVersion: typeof EXPORT_VERSION;
  exportedAt: string;
  planRef: PlanRef;
  run: { runCode: string; status: string; startedAt: string | null; finishedAt: string | null };
  settings: { currency: string | null; uom: string | null };
  plan: Record<string, unknown> | null;
}

const iso = (d: unknown) => (d === null || d === undefined ? null : new Date(d as string).toISOString());

export function buildPlanExport(i: { planRef: PlanRef; run: Row; settings: { currency: unknown; uom: unknown }; plan: unknown; exportedAt: string }): PlanExport {
  let plan: Record<string, unknown> | null = null;
  if (i.plan && typeof i.plan === "object") {
    const { reasonCandidates: _diag, ...rest } = i.plan as Record<string, unknown>; // única remoção (diagnóstico interno do run)
    plan = rest;
  }
  return {
    exportVersion: EXPORT_VERSION,
    exportedAt: i.exportedAt,
    planRef: i.planRef,
    run: { runCode: String(i.run.run_code), status: String(i.run.status), startedAt: iso(i.run.started_at), finishedAt: iso(i.run.finished_at) },
    settings: { currency: (i.settings.currency as string | null) ?? null, uom: (i.settings.uom as string | null) ?? null },
    plan,
  };
}

/** Lê o plano vigente sob RLS (mesma tx do audit). Só approved; latest_run/none → 409 {basis}. */
export async function loadApprovedExport(c: Client, exportedAt: string): Promise<PlanExport> {
  const { planRef, run } = await resolvePlanRef(c);
  if (planRef.basis !== "approved" || !run) throw new HttpError(409, "no_approved_plan", { basis: planRef.basis });
  const st = (await c.query("SELECT currency, uom FROM tenant_settings")).rows[0] ?? {};
  return buildPlanExport({ planRef, run, settings: { currency: st.currency ?? null, uom: st.uom ?? null }, plan: run.plan, exportedAt });
}

export function exportFilename(p: PlanExport, fmt: ExportFormat): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
  return `plan-${safe(String(p.planRef.scenarioId))}-v${safe(String(p.planRef.scenarioVersion))}-${safe(p.run.runCode)}.${fmt}`;
}

// ─── CSV (RFC 4180, separador ",", decimal ".", número cru; null/ausente → vazio) ───
type Col = (typeof CSV_COLUMNS)[number];
const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  // Guarda de fórmula (CSV only, cravo PO): célula string iniciando com = + - @ ganha prefixo '. Números ficam crus (negativos inclusive).
  const s = typeof v === "string" ? (/^[=+\-@]/.test(v) ? `'${v}` : v) : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const line = (o: Partial<Record<Col, unknown>>) => CSV_COLUMNS.map((k) => cell(o[k])).join(",");
const arr = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const meta = (v: unknown) => (v === null || v === undefined ? "" : String(v).replace(/[\r\n]+/g, " "));

export function toCsv(p: PlanExport): string {
  const plan = (p.plan ?? {}) as Row;
  const totals = (plan.totals && typeof plan.totals === "object" ? plan.totals : {}) as Row;
  const head = `# exportVersion=${p.exportVersion};basis=${p.planRef.basis};scenarioId=${meta(p.planRef.scenarioId)};`
    + `scenarioVersion=${meta(p.planRef.scenarioVersion)};runId=${meta(p.planRef.runId)};runCode=${meta(p.run.runCode)};`
    + `approvedAt=${meta(p.planRef.at)};exportedAt=${meta(p.exportedAt)};currency=${meta(p.settings.currency)};uom=${meta(p.settings.uom)}`;
  const rows: string[] = [head, CSV_COLUMNS.join(",")];
  for (const m of TOTAL_METRICS) {
    const top = m === "objective" || m === "period" || m === "solverStatus";
    rows.push(line({ section: "total", metric: m, value: top ? plan[m] : totals[m] }));
  }
  for (const f of arr(plan.flows)) rows.push(line({ section: "flow", route_id: f.routeId, route_code: f.routeCode, sku_id: f.skuId, sku_code: f.skuCode, qty: f.qty }));
  for (const l of arr(plan.local)) rows.push(line({ section: "local", node_id: l.nodeId, sku_id: l.skuId, qty: l.qty }));
  for (const u of arr(plan.unmet)) rows.push(line({ section: "unmet", node_id: u.nodeId, sku_id: u.skuId, qty: u.qty }));
  for (const u of arr(plan.utilization)) rows.push(line({ section: "utilization", node_id: u.nodeId, node_code: u.code, used: u.used, capacity: u.capacity, pct: u.pct }));
  return rows.join("\r\n") + "\r\n";
}
