/**
 * W3 · Task 8 — GET /api/alcada/queue: projeção derivada (policies + cartões Investimento + decision_events), sem tabela.
 * Aprovar/escalar = POST /api/decision-events (Task 7/8), não aqui. Cada item é validado contra o contrato (ajv) antes de sair.
 */
import express from "express";
import { type Pool, withTenant } from "../db/pool.js";
import { ctxOf } from "./common.js";
import { HttpError } from "./errors.js";
import { QUEUE_STATUSES, loadAlcadaQueue } from "../w3/alcada.js";
import { assertAlcadaItem } from "../w3/contract.js";

export function alcadaRouter(pool: Pool) {
  const r = express.Router();
  r.get("/queue", async (req, res) => {
    const st = req.query.status;
    if (st !== undefined && !(QUEUE_STATUSES as readonly unknown[]).includes(st)) {
      throw new HttpError(400, "invalid_input", { field: "status", allowed: QUEUE_STATUSES });
    }
    const view = await withTenant(pool, ctxOf(res).tenantId, loadAlcadaQueue);
    view.items.forEach(assertAlcadaItem);
    const items = st ? view.items.filter((i) => i.status === st) : view.items;
    const notice = {
      out_of_pack: "Alçada fora do pack do tenant: sem gate Finance (Sales aprova)",
      no_policy: "Sem política de alçada publicada: fail-closed (Investimento exige Finance)",
      misconfigured: "Política de alçada sem limiar válido (body.limitMi): fail-closed",
      active: null,
    }[view.mode];
    // W3b: pack com alçada e sem POL / limiar inválido → próximo passo = publicar alçada (PUT /api/cadastro/alcada)
    const nextStep = view.mode === "no_policy" || view.mode === "misconfigured"
      ? { key: "publish_alcada", label: "Publicar a política de alçada", cta: "Publicar alçada", endpoint: "PUT /api/cadastro/alcada" }
      : null;
    res.json({ data: items, mode: view.mode, policy: view.policy, notice, nextStep, needsPolicy: view.needsPolicy });
  });
  return r;
}
