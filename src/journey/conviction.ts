/**
 * W5 · Task 11 — conviction pack (cravo PO 3): JSON + MD em disco + download via GET. Textos = templates pt-BR fixos preenchidos
 * só com números do snapshot da journey; valor ausente → "—" + motivo (nunca inventa $). Sem rede, sem agente gerador de texto.
 * Disco: $JOURNEY_EXPORT_DIR (default var/journey) / <tenantId> / <code>-conviction.{json,md}; conviction_ref = "<tenantId>/<code>-conviction".
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Kpi } from "../w3/kpi.js";
import type { Scope, Step } from "./contract.js";
import type { JourneySnapshot } from "./snapshot.js";

export const PACK_KIND = "journey_conviction_pack";
export const PACK_VERSION = "v0";
export interface ConvictionPack {
  kind: typeof PACK_KIND; version: typeof PACK_VERSION; generatedAt: string;
  lab: { tenantId: string };
  journey: { id: string; code: string; sponsorRole: string | null; scope: Scope; steps: Step[] };
  snapshot: JourneySnapshot;
}

const REASON_PT: Record<string, string> = {
  no_plan: "sem plano — rode o A4", no_data: "sem dado", not_computed_v0: "não calculado na V0",
};
const ROLE_PT: Record<string, string> = { domain_owner: "Dono do domínio", sales: "Vendas", supply: "Supply", finance: "Finanças", admin: "Admin" };
const BASIS_PT: Record<string, string> = { approved: "plano aprovado", latest_run: "último run (não aprovado)", none: "sem plano" };

const fmtNum = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
export function fmtKpi(k: Kpi): string {
  if (k.value === null) return `— (${REASON_PT[k.nullReason ?? "no_data"] ?? "sem dado"})`;
  if (k.unit === "ratio") return `${(k.value * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
  return k.unit ? `${fmtNum(k.value)} ${k.unit}` : fmtNum(k.value);
}
const fmtH = (h: number | null, reason: string | null) => (h === null ? `— (${REASON_PT[reason ?? "no_data"]})` : `${fmtNum(h)} h`);

export function buildPack(a: { tenantId: string; id: string; code: string; sponsorRole: string | null; scope: Scope; steps: Step[];
  snapshot: JourneySnapshot; now?: Date }): ConvictionPack {
  return { kind: PACK_KIND, version: PACK_VERSION, generatedAt: (a.now ?? new Date()).toISOString(), lab: { tenantId: a.tenantId },
    journey: { id: a.id, code: a.code, sponsorRole: a.sponsorRole, scope: a.scope, steps: a.steps }, snapshot: a.snapshot };
}

/** Markdown pt-BR por template fixo. Cada número vem de `p.snapshot`; nenhum texto livre além das notas dos steps (do usuário). */
export function renderMarkdown(p: ConvictionPack): string {
  const s = p.snapshot, L: string[] = [];
  L.push(`# Conviction pack — ${p.journey.code}`, "");
  L.push(`- Gerado em: ${p.generatedAt}`, `- Tenant lab: \`${p.lab.tenantId}\``,
    `- Sponsor: ${p.journey.sponsorRole ? ROLE_PT[p.journey.sponsorRole] ?? p.journey.sponsorRole : "— (não definido)"}`,
    `- Base do plano: ${BASIS_PT[s.planRef.basis] ?? s.planRef.basis}${s.planRef.runId ? ` (run \`${s.planRef.runId}\`)` : ""}`,
    `- Snapshot: ${s.takenAt} · escopo registrado (V0 não filtra): BU ${s.scope.bu ?? "—"}, ${s.scope.nodeStableIds.length} nó(s), ${s.scope.skuFamilies.length} família(s)`, "");
  L.push("## 1. Alavancas", "", "| Alavanca | Valor | Fonte |", "|---|---|---|");
  for (const k of s.leverage.points) L.push(`| ${k.label} | ${fmtKpi(k)} | ${k.source} |`);
  const e = s.leverage.exceptions;
  L.push("", `Exceções abertas no Pulse: ${e.block} bloqueio(s), ${e.warn} alerta(s), ${e.info} info.`, "");
  const d = s.consensus.decisions, lt = s.consensus.latency;
  L.push("## 2. Consenso", "", `- Decisões registradas: ${d.total} (${d.approve} aprovação(ões), ${d.escalate} escalonamento(s))`,
    `- Latência escalonamento → aprovação: mediana ${fmtH(lt.medianHours, lt.nullReason)}, máxima ${fmtH(lt.maxHours, lt.nullReason)} (${lt.pairs} par(es))`,
    `- Pendentes na alçada: ${s.consensus.pendingAlcada}`, "");
  const r = s.roles;
  L.push("## 3. Papéis", "", `- Pack: ${r.pack}`,
    `- Agentes ativos: ${r.agents.filter((a) => a.enabled).map((a) => a.id).join(", ") || "nenhum"}`,
    `- Usuários por papel: ${Object.entries(r.users).map(([k, n]) => `${ROLE_PT[k] ?? k} ${n}`).join(" · ")}`,
    `- Lacunas de papel: ${r.gaps.length ? r.gaps.map((g) => ROLE_PT[g] ?? g).join(", ") : "nenhuma"}`, "");
  L.push("## 4. Passos da journey", "");
  for (const st of p.journey.steps) L.push(`- [${st.status === "done" ? "x" : " "}] ${st.id}${st.at ? ` (${st.at})` : ""}${st.notes ? ` — nota: ${st.notes}` : ""}`);
  L.push("", "_Valores ausentes aparecem como “—” com o motivo; nenhum valor é estimado fora do snapshot._", "");
  return L.join("\n");
}

export const exportDir = () => path.resolve(process.env.JOURNEY_EXPORT_DIR ?? "var/journey");
export const refOf = (tenantId: string, code: string) => `${tenantId}/${code}-conviction`;
function fileOf(ref: string, ext: "json" | "md") {
  const base = exportDir(), f = path.resolve(base, `${ref}.${ext}`);
  if (!f.startsWith(base + path.sep)) throw new Error("conviction_ref fora do diretório de export");
  return f;
}
async function atomicWrite(f: string, data: string) {
  await mkdir(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, f);
}
export async function writePackFiles(ref: string, p: ConvictionPack) {
  const md = renderMarkdown(p);
  await atomicWrite(fileOf(ref, "json"), JSON.stringify(p, null, 2) + "\n");
  await atomicWrite(fileOf(ref, "md"), md);
  return { json: fileOf(ref, "json"), md: fileOf(ref, "md") };
}
export async function readPackFile(ref: string, ext: "json" | "md"): Promise<string | null> {
  try { return await readFile(fileOf(ref, ext), "utf8"); }
  catch (e) { if ((e as { code?: string }).code === "ENOENT") return null; throw e; }
}
