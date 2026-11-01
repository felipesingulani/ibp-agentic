/**
 * W3 · Task 8 — GET /api/visoes/:lens (sales|supply|finance). Mesmo snapshot/planRef do Pulse → números compartilhados idênticos.
 * Lente desconhecida → 400 invalid_lens. Query desconhecida é ignorada (filtros nó/família fora da V0).
 */
import express from "express";
import { type Pool, withTenant } from "../db/pool.js";
import { ctxOf } from "./common.js";
import { HttpError } from "./errors.js";
import { LENSES, type Lens, lensView, loadW3 } from "../w3/snapshot.js";

export function visoesRouter(pool: Pool) {
  const r = express.Router();
  r.get("/:lens", async (req, res) => {
    const lens = req.params.lens;
    if (!(LENSES as readonly string[]).includes(lens)) throw new HttpError(400, "invalid_lens", { allowed: LENSES });
    const snap = await withTenant(pool, ctxOf(res).tenantId, loadW3);
    res.json({ data: lensView(snap, lens as Lens) });
  });
  return r;
}
