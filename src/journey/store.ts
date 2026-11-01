/**
 * W5 · Task 11 — persistência da journey (tabela journey_runs, 0015) no tenant LAB sob RLS (cravo PO 2).
 * Toda escrita: withTenant + advisory lock da journey do tenant + audit. Transições:
 *   open ──snapshot/steps──▶ open ──POST conviction (leverage+consensus+roles done)──▶ conviction
 *   conviction ──step conviction (sign-off)──▶ conviction ──POST land──▶ landed      (abandoned: reservado, sem endpoint V0)
 * Land: landTenantId → só vincula (nada é copiado) se journey_land_link() (0017, W6) confirmar o vínculo — o mesmo ator (e-mail)
 * é admin no alvo; senão 400 invalid_reference uniforme (sem oráculo); omitido → cria tenant thin via journey_land_tenant()
 * (SECURITY DEFINER, 0015/0016) + pack default (o do lab, senão generic) com POL de alçada, sob RLS do tenant novo. Nunca escreve
 * no ERP. Papel do ator (admin|domain_owner) é checado no router antes de qualquer leitura (W6).
 * Steps (W6): ordem forçada leverage → consensus → roles → conviction (409 steps_out_of_order, wire 0.3.9).
 */
import type { Client } from "../db/pool.js";
import { type Ctx, type Row, assertCurrentRefs, audit } from "../http/common.js";
import { HttpError } from "../http/errors.js";
import { GENERIC, genericPack, getPack } from "../cadastro/packs.js";
import { writePack } from "../cadastro/settings.js";
import { applyPackAlcada } from "../cadastro/alcada-write.js";
import { effectivePolicyKinds } from "../domain/policy-kinds.js";
import {
  REVIEW_STEPS, type Scope, type Step, type StepId, STEP_IDS, initialSteps, normScope,
  type createSchema, type landSchema, slugRe, stepOrderGap,
} from "./contract.js";
import type { z } from "zod";
import { type JourneySnapshot, takeSnapshot } from "./snapshot.js";
import { buildPack, refOf, writePackFiles } from "./conviction.js";

export async function lockJourney(c: Client, tenantId: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtext('ibp_journey:' || $1))", [tenantId]);
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const hasSnapshot = (r: Row) => !!r.leverage && typeof r.leverage === "object" && "takenAt" in (r.leverage as object);
export function runOut(r: Row) {
  return {
    id: String(r.id), code: String(r.code), status: String(r.status), sponsorRole: (r.sponsor_role as string | null) ?? null,
    scope: r.scope as Scope, steps: r.steps as Step[], snapshot: hasSnapshot(r) ? (r.leverage as JourneySnapshot) : null,
    convictionRef: (r.conviction_ref as string | null) ?? null, landTenantId: (r.land_tenant_id as string | null) ?? null,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

export async function getRun(c: Client, id: string, forUpdate = false): Promise<Row> {
  const r = (await c.query(`SELECT * FROM journey_runs WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [id])).rows[0];
  if (!r) throw new HttpError(404, "journey_not_found");
  return r;
}
export async function listRuns(c: Client, status?: string) {
  return (await c.query(`SELECT * FROM journey_runs ${status ? "WHERE status = $1" : ""} ORDER BY created_at DESC, id`,
    status ? [status] : [])).rows;
}

async function nextCode(c: Client): Promise<string> {
  let n = Number((await c.query("SELECT count(*)::int AS n FROM journey_runs")).rows[0].n) + 1;
  for (;;) {
    const code = `JR-${String(n).padStart(4, "0")}`;
    if (!(await c.query("SELECT 1 FROM journey_runs WHERE code = $1", [code])).rowCount) return code;
    n++;
  }
}

export async function createRun(c: Client, ctx: Ctx, b: z.infer<typeof createSchema>) {
  await lockJourney(c, ctx.tenantId);
  const scope = normScope(b.scope);
  if (scope.nodeStableIds.length) await assertCurrentRefs(c, "nodes", "scope.nodeStableIds", scope.nodeStableIds);
  const code = b.code ?? await nextCode(c);
  if ((await c.query("SELECT 1 FROM journey_runs WHERE code = $1", [code])).rowCount) throw new HttpError(409, "journey_code_exists", { code });
  const r = (await c.query(
    `INSERT INTO journey_runs (tenant_id, code, sponsor_role, scope, steps) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb) RETURNING *`,
    [ctx.tenantId, code, b.sponsorRole ?? null, JSON.stringify(scope), JSON.stringify(initialSteps())])).rows[0];
  await audit(c, ctx, "create", "journey_runs", String(r.id), { code, scope, sponsorRole: b.sponsorRole ?? null });
  return r;
}

async function save(c: Client, id: string, set: Record<string, unknown>) {
  const cols = Object.keys(set);
  const sql = cols.map((k, i) => `${k} = $${i + 2}${["steps", "leverage", "scope"].includes(k) ? "::jsonb" : ""}`).join(", ");
  const vals = cols.map((k) => (["steps", "leverage", "scope"].includes(k) ? JSON.stringify(set[k]) : set[k]));
  return (await c.query(`UPDATE journey_runs SET ${sql}, updated_at = now() WHERE id = $1 RETURNING *`, [id, ...vals])).rows[0];
}
const needStatus = (r: Row, ...ok: string[]) => {
  if (!ok.includes(String(r.status))) throw new HttpError(409, "journey_invalid_status", { status: r.status, expected: ok });
};
const pendingOf = (steps: Step[], ids: readonly StepId[]) => ids.filter((id) => steps.find((s) => s.id === id)?.status !== "done");

/** Snapshot (só em open). Re-snapshot volta leverage/consensus/roles a pending (revisão foi sobre números antigos). */
export async function snapshotRun(c: Client, ctx: Ctx, id: string) {
  await lockJourney(c, ctx.tenantId);
  const r = await getRun(c, id, true);
  needStatus(r, "open");
  const snap = await takeSnapshot(c, r.scope as Scope, (r.sponsor_role as string | null) ?? null);
  const reset = hasSnapshot(r);
  const steps = (r.steps as Step[]).map((s) => (reset && (REVIEW_STEPS as readonly string[]).includes(s.id)
    ? { ...s, status: "pending" as const, at: null } : s));
  const out = await save(c, id, { leverage: snap, steps });
  await audit(c, ctx, "update", "journey_runs", id, { action: "snapshot", planRef: snap.planRef, resetSteps: reset });
  return out;
}

export async function completeStep(c: Client, ctx: Ctx, id: string, stepId: string, notes: string | null) {
  if (!(STEP_IDS as readonly string[]).includes(stepId)) throw new HttpError(400, "invalid_step", { stepId, expected: STEP_IDS });
  await lockJourney(c, ctx.tenantId);
  const r = await getRun(c, id, true);
  const steps = r.steps as Step[];
  if (steps.find((s) => s.id === stepId)?.status === "done") throw new HttpError(409, "step_already_done", { stepId });
  if (stepId === "conviction") {
    // sign-off do sponsor sobre o pack já gerado
    if (!r.conviction_ref) throw new HttpError(409, "conviction_not_generated", { hint: `POST /api/journey/runs/${id}/conviction` });
    needStatus(r, "conviction");
  } else {
    needStatus(r, "open");
    if (!hasSnapshot(r)) throw new HttpError(409, "snapshot_required", { hint: `POST /api/journey/runs/${id}/snapshot` });
  }
  const gap = stepOrderGap(steps, stepId as StepId); // W6: ordem forçada (wire 0.3.9) — depois das checagens W5, como no mock
  if (gap) throw new HttpError(409, "steps_out_of_order", gap);
  const at = new Date().toISOString();
  const next = steps.map((s) => (s.id === stepId ? { ...s, status: "done" as const, at, notes: notes ?? null } : s));
  const out = await save(c, id, { steps: next });
  await audit(c, ctx, "update", "journey_runs", id, { action: "step_done", stepId, notes: notes ?? null });
  return out;
}

export async function generateConviction(c: Client, ctx: Ctx, id: string) {
  await lockJourney(c, ctx.tenantId);
  const r = await getRun(c, id, true);
  needStatus(r, "open");
  if (!hasSnapshot(r)) throw new HttpError(409, "snapshot_required", { hint: `POST /api/journey/runs/${id}/snapshot` });
  const missing = pendingOf(r.steps as Step[], REVIEW_STEPS);
  if (missing.length) throw new HttpError(409, "steps_incomplete", { missing });
  const ref = refOf(ctx.tenantId, String(r.code));
  const pack = buildPack({ tenantId: ctx.tenantId, id, code: String(r.code), sponsorRole: (r.sponsor_role as string | null) ?? null,
    scope: r.scope as Scope, steps: r.steps as Step[], snapshot: r.leverage as JourneySnapshot });
  await writePackFiles(ref, pack);
  const out = await save(c, id, { status: "conviction", conviction_ref: ref });
  await audit(c, ctx, "update", "journey_runs", id, { action: "conviction", conviction_ref: ref, planRef: pack.snapshot.planRef });
  return out;
}

/** W6 regra 6: recusa de land → log de app nível warn (motivo interno NUNCA vai no corpo HTTP). */
export function landWarn(runId: string, ctx: Ctx, code: string, reason: string) {
  console.warn(JSON.stringify({ level: "warn", event: "journey_land_refused", code, runId, actor: ctx.userId, role: ctx.role,
    tenantId: ctx.tenantId, reason }));
}

async function setTenant(c: Client, tenantId: string) {
  await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

export async function landRun(c: Client, ctx: Ctx, id: string, b: z.infer<typeof landSchema>) {
  await lockJourney(c, ctx.tenantId);
  const r = await getRun(c, id, true);
  needStatus(r, "conviction");
  const missing = pendingOf(r.steps as Step[], STEP_IDS);
  if (missing.length) throw new HttpError(409, "steps_incomplete", { missing });

  if (b.landTenantId) {
    if (b.landTenantId === ctx.tenantId) throw new HttpError(400, "land_is_lab", { field: "landTenantId" });
    // W6 (0017): referência válida ⇔ mesmo e-mail do ator é admin no alvo. false → 400 uniforme (inexistente ≡ sem vínculo).
    const linked = (await c.query("SELECT journey_land_link($1, $2, $3) AS ok", [id, b.landTenantId, ctx.userId])).rows[0]?.ok === true;
    if (!linked) {
      landWarn(id, ctx, "link_refused", "journey_land_link=false (inexistente | sem vínculo | ator não-admin no alvo)");
      throw new HttpError(400, "invalid_reference", { field: "landTenantId" });
    }
    await c.query("SAVEPOINT land_link");
    try {
      const out = await save(c, id, { status: "landed", land_tenant_id: b.landTenantId });
      await audit(c, ctx, "update", "journey_runs", id, { action: "land", mode: "link", landTenantId: b.landTenantId });
      return { run: out, land: { mode: "link" as const, tenantId: b.landTenantId } };
    } catch (e) {
      if ((e as { code?: string }).code !== "23503") throw e;
      await c.query("ROLLBACK TO SAVEPOINT land_link");
      throw new HttpError(400, "invalid_reference", { field: "landTenantId" });
    }
  }

  const slug = b.slug ?? `land-${String(r.code).toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 63);
  if (!slugRe.test(slug)) throw new HttpError(400, "invalid_input", { field: "slug" });
  const name = b.name ?? `Land ${r.code}`;
  let created: { tenant_id: string; admin_user_id: string };
  try {
    created = (await c.query("SELECT * FROM journey_land_tenant($1, $2, $3)", [id, slug, name])).rows[0];
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new HttpError(409, "land_code_exists", { slug });
    throw e;
  }
  // pack default: o pack do lab (NULL ≡ generic); aplicado como POST /api/cadastro/pack, sob RLS do tenant novo
  const labPack = (await c.query("SELECT industry_pack FROM tenant_settings")).rows[0]?.industry_pack as string | null | undefined;
  const pack = (labPack && getPack(labPack)) || genericPack();
  const why = `land journey ${r.code} (lab ${ctx.tenantId})`;
  const tctx: Ctx = { tenantId: created.tenant_id, userId: created.admin_user_id, role: "journey_land" };
  await setTenant(c, created.tenant_id);
  await writePack(c, tctx, pack, why, null);
  const alcada = await applyPackAlcada(c, tctx, effectivePolicyKinds({}), pack, why);
  await audit(c, tctx, "create", "tenants", created.tenant_id, { why, action: "journey_land", journeyRunId: id, labTenantId: ctx.tenantId, slug });
  await setTenant(c, ctx.tenantId);
  const out = await save(c, id, { status: "landed", land_tenant_id: created.tenant_id });
  await audit(c, ctx, "update", "journey_runs", id, { action: "land", mode: "created", landTenantId: created.tenant_id, slug, pack: pack.profile_id });
  return { run: out, land: { mode: "created" as const, tenantId: created.tenant_id, slug, name, adminUserId: created.admin_user_id,
    adminEmail: `admin@${slug}.local`, pack: pack.profile_id ?? GENERIC, alcada } };
}
