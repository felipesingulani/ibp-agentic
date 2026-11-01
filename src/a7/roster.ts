/**
 * T-A7-LEVE — gate do A7 no roster: agents.A7.enabled === true (pack do tenant + override tenant_settings.agent_roster).
 * Mesma regra do gate A1 (override por agente vence o pack; sem pack → generic, que tem A7.enabled=false).
 */
import type { Client } from "../db/pool.js";
import { genericPack, getPack } from "../cadastro/packs.js";
import { HttpError } from "../http/errors.js";

export async function a7Enabled(c: Client): Promise<boolean> {
  const row = (await c.query("SELECT industry_pack, agent_roster FROM tenant_settings")).rows[0];
  const pack = (typeof row?.industry_pack === "string" && getPack(row.industry_pack)) || genericPack();
  const stored = (row?.agent_roster ?? {}) as Record<string, { enabled?: boolean }>;
  const a7 = stored.A7 ?? (pack.agents as Record<string, { enabled?: boolean }>).A7;
  return a7?.enabled === true;
}

export async function assertA7Enabled(c: Client) {
  if (!(await a7Enabled(c))) throw new HttpError(409, "a7_disabled", { agent: "A7", hint: "A7 desligado no roster (pack/tenant_settings)" });
}
