/**
 * W3 · Task 8 — GET /api/pulse/summary · GET /api/pulse/exceptions (docs/architecture/W3-PULSE-VISOES-API-CONTRACT.md).
 * Só leitura (gate regra 6): sem escrita, sem agente; números de src/w3/snapshot.ts (mesma função das Visões).
 */
import express from "express";
import { type Pool, withTenant } from "../db/pool.js";
import { ctxOf } from "./common.js";
import { HttpError } from "./errors.js";
import { loadW3, pulseSummary } from "../w3/snapshot.js";
import { SEVERITIES } from "../w3/exceptions.js";

export function pulseRouter(pool: Pool) {
  const r = express.Router();
  r.get("/summary", async (_req, res) => {
    const snap = await withTenant(pool, ctxOf(res).tenantId, loadW3);
    res.json({ data: pulseSummary(snap) });
  });
  r.get("/exceptions", async (req, res) => {
    const sev = req.query.severity;
    if (sev !== undefined && !(SEVERITIES as readonly unknown[]).includes(sev)) {
      throw new HttpError(400, "invalid_input", { field: "severity", allowed: SEVERITIES });
    }
    const snap = await withTenant(pool, ctxOf(res).tenantId, loadW3);
    res.json({ data: sev ? snap.exceptions.filter((e) => e.severity === sev) : snap.exceptions, planRef: snap.planRef });
  });
  return r;
}
