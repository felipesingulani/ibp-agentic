/**
 * W3b · Task 9 — Cadastro write API (contrato docs/architecture/W3B-CADASTRO-WRITE-API-CONTRACT.md):
 *   GET  /api/cadastro/packs        registry packs/*.json (sem DB)
 *   GET  /api/tenant-settings       + industry_pack, entity_labels, policy_kinds, agent_roster, alcada {inPack, mode, policy}
 *   PUT  /api/tenant-settings       settingsSchema .strict() + overrides entity_labels / policy_kinds / agent_roster
 *   POST /api/cadastro/pack         aplica pack {pack, why} (Regras 1–2)
 *   PUT  /api/cadastro/alcada       publica/edita/limpa limiar {limitMi, why} (Regras 3, 5)
 * Tudo sob withTenant (RLS) + lockTenant + audit. Sem IA generativa / sem rede (gate regra 7).
 */
import express from "express";
import { z } from "zod";
import { type Pool, withTenant } from "../db/pool.js";
import { audit, ctxOf, requireUser, whySchema } from "./common.js";
import { HttpError } from "./errors.js";
import { effectivePolicyKinds } from "../domain/policy-kinds.js";
import { getPack, listPacks, packIds } from "../cadastro/packs.js";
import {
  type AgentRoster, lockTenant, mergePolicyKinds, readSettingsRow, settingsView, validateAgentRoster, validateEntityLabels, writePack,
} from "../cadastro/settings.js";
import { applyPackAlcada, upsertAlcada, validateLimitMi } from "../cadastro/alcada-write.js";

const settingsSchema = z.object({
  currency: z.string().min(1).nullable().optional(),
  uom: z.string().min(1).nullable().optional(),
  node_types: z.array(z.string().min(1)).optional(),
  kpi_labels: z.record(z.string(), z.string()).optional(),
  supply_external_in_scope: z.boolean().optional(), // W1b: exige contrato de fornecedor na prontidão A4
  confirmed: z.boolean().optional(), // 0010: true → confirmed_at = now() (servidor); false → NULL; ausente → mantém
  // W3b (0013): overrides parciais — validados com códigos próprios (invalid_labels | invalid_policy_kinds | ambiguous_policy_kind | invalid_agent_roster)
  entity_labels: z.unknown().optional(),
  policy_kinds: z.unknown().optional(),
  agent_roster: z.unknown().optional(),
}).strict();

const packBody = z.object({ pack: z.string().min(1), why: whySchema.shape.why }).strict();
const alcadaBody = z.object({ limitMi: z.unknown(), why: whySchema.shape.why }).strict();

export function mountCadastro(api: express.Router, pool: Pool) {
  api.get("/cadastro/packs", (_req, res) => res.json({ data: listPacks() }));

  api.get("/tenant-settings", async (_req, res) => {
    const ctx = ctxOf(res);
    res.json({ data: await withTenant(pool, ctx.tenantId, (c) => settingsView(c, ctx.tenantId)) });
  });

  api.put("/tenant-settings", async (req, res) => {
    const ctx = ctxOf(res);
    requireUser(ctx);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    if (raw && typeof raw === "object" && "industry_pack" in raw)
      throw new HttpError(400, "use_pack_endpoint", { field: "industry_pack", hint: "POST /api/cadastro/pack" });
    const s = settingsSchema.parse(raw);
    const labels = "entity_labels" in s ? validateEntityLabels(s.entity_labels) : undefined;
    const rosterPatch = "agent_roster" in s ? validateAgentRoster(s.agent_roster) : undefined;
    const data = await withTenant(pool, ctx.tenantId, async (c) => {
      await lockTenant(c, ctx.tenantId);
      const prev = await readSettingsRow(c);
      const kinds = "policy_kinds" in s ? mergePolicyKinds(prev?.policy_kinds ?? {}, s.policy_kinds) : undefined;
      const roster = rosterPatch ? { ...((prev?.agent_roster as AgentRoster | undefined) ?? {}), ...rosterPatch } : undefined;
      const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
      await c.query(
        `INSERT INTO tenant_settings (tenant_id, currency, uom, node_types, kpi_labels, supply_external_in_scope, confirmed_at,
                                      entity_labels, policy_kinds, agent_roster, updated_at)
         VALUES ($1, $2, $3, COALESCE($4, '{}'::text[]), COALESCE($5::jsonb, '{}'::jsonb), COALESCE($8::boolean, false),
                 CASE WHEN $9::boolean THEN now() END,
                 COALESCE($10::jsonb, '{}'::jsonb), COALESCE($11::jsonb, '{}'::jsonb), COALESCE($12::jsonb, '{}'::jsonb), now())
         ON CONFLICT (tenant_id) DO UPDATE SET
           currency = CASE WHEN $6 THEN EXCLUDED.currency ELSE tenant_settings.currency END,
           uom = CASE WHEN $7 THEN EXCLUDED.uom ELSE tenant_settings.uom END,
           node_types = CASE WHEN $4::text[] IS NOT NULL THEN EXCLUDED.node_types ELSE tenant_settings.node_types END,
           kpi_labels = CASE WHEN $5::jsonb IS NOT NULL THEN EXCLUDED.kpi_labels ELSE tenant_settings.kpi_labels END,
           supply_external_in_scope = CASE WHEN $8::boolean IS NOT NULL THEN EXCLUDED.supply_external_in_scope
                                           ELSE tenant_settings.supply_external_in_scope END,
           confirmed_at = CASE WHEN $9::boolean IS NULL THEN tenant_settings.confirmed_at
                               WHEN $9::boolean THEN now() ELSE NULL END,
           entity_labels = CASE WHEN $10::jsonb IS NOT NULL THEN EXCLUDED.entity_labels ELSE tenant_settings.entity_labels END,
           policy_kinds = CASE WHEN $11::jsonb IS NOT NULL THEN EXCLUDED.policy_kinds ELSE tenant_settings.policy_kinds END,
           agent_roster = CASE WHEN $12::jsonb IS NOT NULL THEN EXCLUDED.agent_roster ELSE tenant_settings.agent_roster END,
           updated_at = now()`,
        [ctx.tenantId, s.currency ?? null, s.uom ?? null, s.node_types ?? null,
         s.kpi_labels ? JSON.stringify(s.kpi_labels) : null, "currency" in s, "uom" in s, s.supply_external_in_scope ?? null,
         s.confirmed ?? null, j(labels), j(kinds), j(roster)]);
      const changes: Record<string, unknown> = { ...s };
      if (labels) changes.entity_labels = labels;
      if (kinds) changes.policy_kinds = kinds;
      if (rosterPatch) changes.agent_roster = rosterPatch;
      await audit(c, ctx, "update", "tenant_settings", ctx.tenantId, { changes });
      return settingsView(c, ctx.tenantId);
    });
    res.json({ data });
  });

  api.post("/cadastro/pack", async (req, res) => {
    const ctx = ctxOf(res);
    requireUser(ctx);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pack = typeof body.pack === "string" ? getPack(body.pack) : undefined;
    if (typeof body.pack === "string" && !pack) throw new HttpError(400, "invalid_pack", { allowed: packIds() });
    const { why } = packBody.parse(body);
    const out = await withTenant(pool, ctx.tenantId, async (c) => {
      await lockTenant(c, ctx.tenantId);
      const prev = await readSettingsRow(c);
      const prevKinds = effectivePolicyKinds(prev?.policy_kinds ?? {});
      await writePack(c, ctx, pack!, why, (prev?.industry_pack as string | null) ?? null);
      const alcadaEffect = await applyPackAlcada(c, ctx, prevKinds, pack!, why);
      return { data: await settingsView(c, ctx.tenantId), alcadaEffect };
    });
    res.json(out);
  });

  api.put("/cadastro/alcada", async (req, res) => {
    const ctx = ctxOf(res);
    requireUser(ctx);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!body || typeof body !== "object" || !("limitMi" in body)) throw new HttpError(400, "invalid_limit_mi", { expected: "number ≥ 0 | null" });
    const limitMi = validateLimitMi(body.limitMi);
    const { why } = alcadaBody.parse(body);
    const out = await withTenant(pool, ctx.tenantId, async (c) => {
      const r = await upsertAlcada(c, ctx, limitMi, why);
      const { id, stable_id, version, kind, name, body: pb } = r.policy;
      return { data: await settingsView(c, ctx.tenantId), policy: { id, stable_id, version, kind, name, body: pb },
        action: r.action, packSwitched: r.packSwitched };
    });
    res.json(out);
  });
}
