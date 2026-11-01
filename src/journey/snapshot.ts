/**
 * W5 · Task 11 — snapshot da journey (SELECT-only, tenant LAB sob RLS). Mesmos números do Pulse (loadW3 da W3/W4), nunca inventa $:
 *   leverage  = WC / serviço / expedite (+ custo, aderência, exceções) — KPI {value|null + nullReason}; sem plano → no_plan
 *   consensus = contagem de DecisionEvents (approve/escalate) + latência escalate→approve (h) por versão de cenário
 *   roles     = roster de agentes (tenant › pack) + usuários por papel (domain_owner/sales/supply/finance) + gaps (= 0 usuários)
 * V0: escopo (bu/nós/famílias) é registrado, não filtra (scopeFilter = "tenant_v0"). Determinístico, sem rede, sem agente.
 */
import type { Client } from "../db/pool.js";
import { adherenceKpi, loadW3, pendingAlcada, pulseKpis } from "../w3/snapshot.js";
import type { Kpi, NullReason } from "../w3/kpi.js";
import { genericPack, getPack } from "../cadastro/packs.js";
import { ROLES, type Scope } from "./contract.js";

export interface Consensus {
  decisions: { approve: number; escalate: number; total: number };
  latency: { pairs: number; medianHours: number | null; maxHours: number | null; nullReason: NullReason | null; source: string };
  pendingAlcada: number;
}
export interface Roles {
  pack: string; agents: { id: string; enabled: boolean; mode: string | null }[];
  users: Record<(typeof ROLES)[number], number>; gaps: string[]; sponsorRole: string | null;
}
export interface JourneySnapshot {
  takenAt: string; scope: Scope; scopeFilter: "tenant_v0";
  planRef: { basis: string; scenarioId: string | null; scenarioVersion: number | null; runId: string | null; at: string | null };
  leverage: { points: Kpi[]; exceptions: { block: number; warn: number; info: number } };
  consensus: Consensus; roles: Roles;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Latência escalate→approve: por (cenário, versão), 1º escalate → 1º approve em/apos ele. Sem par → null + no_data. */
export function latencyOf(hours: number[]): Consensus["latency"] {
  const source = "decision_events: 1º escalate → 1º approve seguinte (mesmo cenário+versão)";
  if (!hours.length) return { pairs: 0, medianHours: null, maxHours: null, nullReason: "no_data", source };
  return { pairs: hours.length, medianHours: r2(median(hours)!), maxHours: r2(Math.max(...hours)), nullReason: null, source };
}

/** Pontos de alavanca a partir dos KPIs do Pulse. Expedite não tem fonte V0 → null (no_plan sem plano, senão not_computed_v0). */
export function leveragePoints(kpis: Kpi[], adherence: Kpi, basis: string, currency: string | null): Kpi[] {
  const by = (k: string) => kpis.find((x) => x.key === k)!;
  const expedite: Kpi = { key: "expedite", label: "Expedite (custo de urgência)", value: null, unit: currency ? `${currency} mi` : null,
    nullReason: basis === "none" ? "no_plan" : "not_computed_v0", source: "sem fonte V0 (fretes/expedições não modelados)" };
  return [by("wc"), by("svc"), expedite, by("cost"), adherence];
}

export function rolesOf(settingsRow: Record<string, unknown> | undefined, counts: Map<string, number>, sponsorRole: string | null): Roles {
  const packId = typeof settingsRow?.industry_pack === "string" ? settingsRow.industry_pack : null;
  const pack = (packId && getPack(packId)) || genericPack();
  const stored = (settingsRow?.agent_roster ?? {}) as Record<string, { enabled?: boolean; mode?: string }>;
  const roster = { ...(pack.agents as Record<string, { enabled?: boolean; mode?: string }>), ...stored };
  const agents = Object.keys(roster).sort().map((id) => ({ id, enabled: roster[id]?.enabled === true, mode: roster[id]?.mode ?? null }));
  const users = Object.fromEntries(ROLES.map((r) => [r, counts.get(r) ?? 0])) as Roles["users"];
  return { pack: pack.profile_id, agents, users, gaps: ROLES.filter((r) => users[r] === 0), sponsorRole };
}

export async function takeSnapshot(c: Client, scope: Scope, sponsorRole: string | null): Promise<JourneySnapshot> {
  const s = await loadW3(c);
  const sev = { block: 0, warn: 0, info: 0 };
  for (const e of s.exceptions) sev[e.severity as keyof typeof sev] = (sev[e.severity as keyof typeof sev] ?? 0) + 1;

  const dec = (await c.query("SELECT action, count(*)::int AS n FROM decision_events GROUP BY action")).rows;
  const nOf = (a: string) => Number(dec.find((r) => r.action === a)?.n ?? 0);
  const lat = (await c.query(
    `WITH esc AS (SELECT scenario_id, scenario_version, min(at) AS e FROM decision_events WHERE action = 'escalate' GROUP BY 1, 2)
     SELECT extract(epoch FROM min(d.at) - esc.e)::float8 / 3600 AS h
       FROM esc JOIN decision_events d ON d.scenario_id = esc.scenario_id AND d.scenario_version = esc.scenario_version
                                       AND d.action = 'approve' AND d.at >= esc.e
      GROUP BY esc.scenario_id, esc.scenario_version, esc.e`)).rows.map((r) => Number(r.h));

  const counts = new Map((await c.query("SELECT role, count(*)::int AS n FROM users GROUP BY role")).rows
    .map((r) => [String(r.role), Number(r.n)] as [string, number]));
  const settingsRow = (await c.query("SELECT industry_pack, agent_roster FROM tenant_settings")).rows[0];

  return {
    takenAt: new Date().toISOString(), scope, scopeFilter: "tenant_v0", planRef: s.planRef,
    leverage: { points: leveragePoints(pulseKpis(s), adherenceKpi(s), s.planRef.basis, s.settings.currency), exceptions: sev },
    consensus: { decisions: { approve: nOf("approve"), escalate: nOf("escalate"), total: nOf("approve") + nOf("escalate") },
      latency: latencyOf(lat), pendingAlcada: pendingAlcada(s) },
    roles: rolesOf(settingsRow, counts, sponsorRole),
  };
}
