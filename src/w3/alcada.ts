/**
 * W3 · Task 8 — fila de alçada Finance (contracts/alcada-queue-item.schema.json). Projeção read-only: sem tabela,
 * derivada de scenarios + premise_cards (Investimento) + policies (kind `alcada`, body.limitMi) + decision_events.
 *
 * Vocabulário (W3b): policies.kind normalizado ∈ tenant_settings.policy_kinds.alcada ({} → legado ["alcada"] ≡ generic).
 * Limiar = body.limitMi (mi da moeda).
 * Impacto = soma de fields.impactMi dos cartões Investimento do cenário (já em mi; agnóstico — o pack só muda o label).
 * Modo (cravado PO + arquitetura = fail-closed):
 *   out_of_pack   → pack do tenant SEM alçada (policy_kinds sem chave alcada) → único fail-open: fila vazia; Sales aprova
 *   no_policy     → pack com alçada e nenhuma POL corrente → fail-closed (≡ limiar 0): Investimento exige Finance;
 *                   fila vazia (policyRef obrigatório no contrato) + notice/nextStep "publicar alçada" (W3b, cravo PO)
 *   misconfigured → POL de alçada existe sem limitMi numérico ≥ 0 → todo cenário com Investimento entra (fail-closed)
 *   active        → entra se impactMi > alcadaMi ou impactMi = null (cartão Investimento sem número legível)
 * Várias POL de alçada correntes: qualquer uma inválida → misconfigured; senão vale o MENOR limiar (mais restritivo).
 * Status: última decisão com actor.role=finance na versão → approved_finance|escalated_owner; senão versão superada → stale;
 *   senão pending_finance. Versão fechada por approve de outro papel sem decisão Finance (ex.: antes da POL existir) → fora da fila.
 */
import type { Client } from "../db/pool.js";
import { LEGACY_POLICY_KINDS, effectivePolicyKinds, normalizeKind } from "../domain/policy-kinds.js";
import { type DecisionOut, DECISION_SELECT, decisionOut } from "../a7/event-out.js";

export const QUEUE_STATUSES = ["pending_finance", "approved_finance", "escalated_owner", "stale"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];
export type AlcadaMode = "out_of_pack" | "no_policy" | "misconfigured" | "active";

export interface PolicyRow { stable_id: string; version: number; kind: string; body: unknown }
export interface AlcadaPolicy { id: string; version: number; alcadaMi: number | null }

/** aliases normalizados de alçada do tenant; null = fora do pack. Default = legado (≡ generic). */
export const isAlcadaKind = (kind: string, aliases: readonly string[] = LEGACY_POLICY_KINDS.alcada) =>
  aliases.includes(normalizeKind(kind));

/** Número em mi legível: number finito ≥ 0, ou string decimal simples ("12", "12.5", "12,5"). Nunca estima. */
export function readMi(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^\s*\d+([.,]\d+)?\s*$/.test(v)) return Number(v.trim().replace(",", "."));
  return null;
}

export function resolveAlcadaPolicy(
  policies: PolicyRow[], aliases: readonly string[] | null = LEGACY_POLICY_KINDS.alcada,
): { mode: AlcadaMode; policy: AlcadaPolicy | null } {
  if (aliases === null) return { mode: "out_of_pack", policy: null };
  const alc = policies.filter((p) => isAlcadaKind(p.kind, aliases));
  if (!alc.length) return { mode: "no_policy", policy: null };
  const parsed = alc.map((p) => ({ p, lim: readMi((p.body as { limitMi?: unknown } | null)?.limitMi) }));
  const bad = parsed.find((x) => x.lim === null);
  if (bad) return { mode: "misconfigured", policy: { id: bad.p.stable_id, version: bad.p.version, alcadaMi: null } };
  const best = parsed.reduce((a, b) => ((b.lim as number) < (a.lim as number) ? b : a));
  return { mode: "active", policy: { id: best.p.stable_id, version: best.p.version, alcadaMi: best.lim } };
}

/** Investimento do cenário: has=false se não há cartão; impactMi=null se algum cartão não tem número legível. */
export function scenarioImpact(cards: { type: string; fields: unknown }[]): { has: boolean; impactMi: number | null } {
  const inv = cards.filter((c) => c.type === "Investimento");
  if (!inv.length) return { has: false, impactMi: null };
  let sum = 0;
  for (const c of inv) {
    const v = readMi((c.fields as { impactMi?: unknown } | null)?.impactMi);
    if (v === null) return { has: true, impactMi: null };
    sum += v;
  }
  return { has: true, impactMi: Math.round(sum * 1e6) / 1e6 };
}

/** O cenário (versão corrente) precisa passar pela Finance? Mesma regra para a fila e para o POST da decisão. */
export function requiresFinance(mode: AlcadaMode, policy: AlcadaPolicy | null, imp: { has: boolean; impactMi: number | null }): boolean {
  if (!imp.has || mode === "out_of_pack") return false;
  if (mode === "misconfigured" || mode === "no_policy") return true; // fail-closed ≡ limiar 0
  return imp.impactMi === null || imp.impactMi > (policy?.alcadaMi ?? 0);
}

/** Limiar efetivo no item: active → limitMi; misconfigured/no_policy → 0 (fail-closed: tudo com Investimento passa pela Finance). */
export const effectiveAlcadaMi = (mode: AlcadaMode, policy: AlcadaPolicy | null) =>
  mode === "active" ? (policy?.alcadaMi ?? 0) : 0;

export function queueStatus(events: DecisionOut[], superseded: boolean): QueueStatus | null {
  const fin = events.filter((e) => e.actor.role === "finance");
  const lastFin = fin[fin.length - 1];
  if (lastFin) return lastFin.action === "approve" ? "approved_finance" : "escalated_owner";
  if (superseded) return "stale";
  if (events.some((e) => e.action === "approve")) return null; // fechado fora da alçada (sem Finance)
  return "pending_finance";
}

export interface AlcadaQueueItem {
  id: string; scenarioId: string; scenarioVersion: number; name: string; runId: string | null;
  impactMi: number | null; alcadaMi: number; policyRef: { id: string; version: number };
  status: QueueStatus; escalateTo: "finance" | "domain_owner" | null; events: DecisionOut[];
  createdAt: string; updatedAt: string;
}
export interface AlcadaView {
  mode: AlcadaMode; policy: AlcadaPolicy | null; items: AlcadaQueueItem[];
  /** no_policy: cenários vivos com Investimento travados até publicar a alçada (fail-closed); senão 0 */
  needsPolicy: number;
}

const ORDER: Record<QueueStatus, number> = { pending_finance: 0, escalated_owner: 1, approved_finance: 2, stale: 3 };
const iso = (d: unknown) => new Date(d as string).toISOString();
const maxIso = (...ds: (string | null | undefined)[]) =>
  ds.filter((d): d is string => !!d).reduce((a, b) => (b > a ? b : a));

/** Aliases de alçada do tenant (null = fora do pack) — lê tenant_settings.policy_kinds sob RLS. */
export async function loadAlcadaAliases(c: Client): Promise<string[] | null> {
  const r = (await c.query("SELECT policy_kinds FROM tenant_settings")).rows[0];
  return effectivePolicyKinds(r?.policy_kinds ?? {}).alcada;
}

export async function loadAlcadaPolicy(c: Client) {
  const aliases = await loadAlcadaAliases(c);
  const pol = (await c.query("SELECT stable_id, version, kind, body FROM policies WHERE is_current ORDER BY created_at, stable_id")).rows;
  return resolveAlcadaPolicy(pol as PolicyRow[], aliases);
}

export async function loadScenarioImpact(c: Client, scenarioId: string) {
  const cards = (await c.query("SELECT type, fields FROM premise_cards WHERE scenario_id = $1 AND type = 'Investimento'", [scenarioId])).rows;
  return scenarioImpact(cards);
}

/** Fila inteira do tenant (sob RLS). Ordem: abertos primeiro (pending_finance, escalated_owner), depois approved, stale. */
export async function loadAlcadaQueue(c: Client): Promise<AlcadaView> {
  const { mode, policy } = await loadAlcadaPolicy(c);
  if (mode === "no_policy") {
    const n = (await c.query(`SELECT count(DISTINCT s.id)::int AS n FROM scenarios s
        JOIN premise_cards pc ON pc.scenario_id = s.id AND pc.type = 'Investimento'
       WHERE s.is_current AND s.status <> 'archived'`)).rows[0].n as number;
    return { mode, policy, items: [], needsPolicy: n };
  }
  if (mode === "out_of_pack" || !policy) return { mode, policy, items: [], needsPolicy: 0 };
  const scen = (await c.query("SELECT id, code, name, version, is_current, status, created_at FROM scenarios")).rows;
  const cards = (await c.query(
    "SELECT scenario_id, type, fields, created_at FROM premise_cards WHERE type = 'Investimento'")).rows;
  const evRows = (await c.query(`${DECISION_SELECT} ORDER BY d.at, d.id`)).rows;
  const runs = (await c.query(
    `SELECT DISTINCT ON (scenario_id, scenario_version) id, scenario_id, scenario_version FROM a4_runs
      WHERE status IN ('feasible','partial') ORDER BY scenario_id, scenario_version, started_at DESC`)).rows;
  const runOf = new Map(runs.map((r) => [`${r.scenario_id}|${r.scenario_version}`, String(r.id)]));
  const evBy = new Map<string, DecisionOut[]>();
  for (const r of evRows) {
    const k = `${r.scenario_id}|${r.scenario_version}`;
    evBy.set(k, [...(evBy.get(k) ?? []), decisionOut(r)]);
  }
  const items: AlcadaQueueItem[] = [];
  const ref = { id: policy.id, version: policy.version };
  for (const s of scen) {
    const sCards = cards.filter((x) => x.scenario_id === s.id);
    const imp = scenarioImpact(sCards);
    // versões anteriores (ou linha não corrente) que passaram pela alçada → itens históricos (stale ou decisão Finance)
    const versions = new Set<number>();
    for (const k of evBy.keys()) if (k.startsWith(`${s.id}|`)) versions.add(Number(k.split("|")[1]));
    for (const v of [...versions].sort((a, b) => a - b)) {
      const live = s.is_current && v === s.version;
      if (live) continue;
      const evs = evBy.get(`${s.id}|${v}`) ?? [];
      const touched = evs.some((e) => e.actor.role === "finance" || e.escalateTo === "finance" || (e.alcadaMi ?? null) !== null);
      if (!touched) continue;
      const status = queueStatus(evs, true);
      if (!status) continue;
      const snap = [...evs].reverse().find((e) => e.impactMi !== undefined);
      const lim = [...evs].reverse().find((e) => typeof e.alcadaMi === "number")?.alcadaMi;
      items.push({
        id: `AQ-${s.code}-v${v}`, scenarioId: String(s.id), scenarioVersion: v, name: String(s.name),
        runId: runOf.get(`${s.id}|${v}`) ?? null, impactMi: snap ? (snap.impactMi ?? null) : imp.impactMi,
        alcadaMi: lim ?? effectiveAlcadaMi(mode, policy), policyRef: ref, status,
        escalateTo: status === "escalated_owner" ? "domain_owner" : null, events: evs,
        createdAt: evs[0]?.at ?? iso(s.created_at), updatedAt: maxIso(iso(s.created_at), ...evs.map((e) => e.at)),
      });
    }
    if (!s.is_current || s.status === "archived" || !requiresFinance(mode, policy, imp)) continue;
    const evs = evBy.get(`${s.id}|${s.version}`) ?? [];
    const status = queueStatus(evs, false);
    if (!status) continue;
    const created = iso(s.created_at);
    items.push({
      id: `AQ-${s.code}-v${s.version}`, scenarioId: String(s.id), scenarioVersion: Number(s.version), name: String(s.name),
      runId: runOf.get(`${s.id}|${s.version}`) ?? null, impactMi: imp.impactMi, alcadaMi: effectiveAlcadaMi(mode, policy),
      policyRef: ref, status,
      escalateTo: status === "pending_finance" ? "finance" : status === "escalated_owner" ? "domain_owner" : null,
      events: evs,
      createdAt: evs[0] && evs[0].at < created ? evs[0].at : created,
      updatedAt: maxIso(created, ...evs.map((e) => e.at), ...sCards.map((x) => iso(x.created_at))),
    });
  }
  items.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { mode, policy, items, needsPolicy: 0 };
}
