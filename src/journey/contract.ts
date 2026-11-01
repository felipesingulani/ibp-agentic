/**
 * W5 · Task 11 — Journey D3: tipos + zod da API (docs/architecture/W5-JOURNEY-D3-CONTRACT.md).
 * Steps fixos V0 (ordem): leverage · consensus · roles · conviction. Status: open → conviction → landed (abandoned reservado).
 */
import { z } from "zod";

export const STEP_IDS = ["leverage", "consensus", "roles", "conviction"] as const;
export type StepId = (typeof STEP_IDS)[number];
export const REVIEW_STEPS = ["leverage", "consensus", "roles"] as const; // exigem snapshot; pré-requisito do conviction pack
export const JOURNEY_STATUSES = ["open", "conviction", "landed", "abandoned"] as const;
export const ROLES = ["domain_owner", "sales", "supply", "finance"] as const; // papéis do roster de decisão (users.role)
export const SPONSOR_ROLES = [...ROLES, "admin"] as const;

export interface Step { id: StepId; status: "pending" | "done"; at: string | null; notes: string | null }
export const initialSteps = (): Step[] => STEP_IDS.map((id) => ({ id, status: "pending", at: null, notes: null }));

/** W6 · Task 12 (cravo PO + wire 0.3.9): papéis que podem dar land (thin e link). */
export const LAND_ROLES = ["admin", "domain_owner"] as const;

/**
 * W6 · Task 12 — ordem forçada (wire 0.3.9 jrOrder): passo N só conclui com todos os anteriores done.
 * null = em ordem; senão corpo do 409 steps_out_of_order {stepId, requires (passo imediatamente anterior), missing (anteriores pendentes)}.
 */
export function stepOrderGap(steps: Step[], stepId: StepId): { stepId: StepId; requires: StepId | null; missing: StepId[] } | null {
  const i = STEP_IDS.indexOf(stepId);
  const missing = STEP_IDS.slice(0, i).filter((id) => steps.find((s) => s.id === id)?.status !== "done");
  return missing.length ? { stepId, requires: i > 0 ? STEP_IDS[i - 1] : null, missing } : null;
}

export const codeRe = /^JR-[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
export const slugRe = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const scopeSchema = z.object({
  bu: z.string().trim().min(1).max(80).optional(),
  nodeStableIds: z.array(z.uuid()).max(500).optional(),
  skuFamilies: z.array(z.string().trim().min(1).max(80)).max(500).optional(),
}).strict();
export type Scope = { bu?: string; nodeStableIds: string[]; skuFamilies: string[] };
export const normScope = (s: z.infer<typeof scopeSchema> | undefined): Scope => ({
  ...(s?.bu ? { bu: s.bu } : {}),
  nodeStableIds: [...new Set(s?.nodeStableIds ?? [])],
  skuFamilies: [...new Set(s?.skuFamilies ?? [])],
});

export const createSchema = z.object({
  code: z.string().regex(codeRe, "code = JR-[A-Za-z0-9_-] (≤ 43)").optional(),
  scope: scopeSchema.optional(),
  sponsorRole: z.enum(SPONSOR_ROLES).nullable().optional(),
}).strict();
export const stepSchema = z.object({ notes: z.string().trim().max(2000).nullable().optional() }).strict();
export const landSchema = z.object({
  landTenantId: z.uuid().optional(),
  slug: z.string().regex(slugRe, "slug = [a-z0-9-] (2..63)").optional(),
  name: z.string().trim().min(1).max(120).optional(),
}).strict().refine((b) => !(b.landTenantId && (b.slug || b.name)), { message: "landTenantId não combina com slug/name (thin só quando omitido)" });
export const listQuery = z.object({ status: z.enum(JOURNEY_STATUSES).optional() }).strict();
export const downloadQuery = z.object({ format: z.enum(["json", "md"]).optional() }).strict();
