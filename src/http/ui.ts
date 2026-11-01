/**
 * Home pública = shell/wire v0.3.9 da Didi (public/index.html, congelado; mock in-browser, auth = stub demo do wire).
 * Listas de cadastro W0 (read-only, server-rendered) seguem em /ui e /ui/:entity — só no Express long-running
 * (local/Render); na Vercel Hobby `/` é estático e só /api/* + /health vão pra função.
 * Tenant das listas via ?tenant_id= (stub de dev, mesmo RLS da API).
 */
import { fileURLToPath } from "node:url";
import express from "express";
import { type Pool, withTenant } from "../db/pool.js";
import { aliasOut, apiFields, entities, entityByPath } from "../domain/entities.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const page = (title: string, body: string) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Cadastro W0</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#1b1f24}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top}th{background:#f6f8fa}
nav a{margin-right:12px}code{font-size:12px}</style></head><body>
<h1>Cadastro (W0 foundation)</h1>${body}</body></html>`;

export function uiRouter(pool: Pool) {
  const r = express.Router();
  const nav = (t: string) =>
    `<nav>${entities.map((e) => `<a href="/ui/${e.path}?tenant_id=${esc(t)}">${esc(e.path)}</a>`).join("")}</nav>`;

  // `/` (e `/?tenant_id=…`) = shell 0.3.9 byte-idêntico (md5 8f5dddf9…); o wire é mock e ignora tenant_id.
  const publicDir = fileURLToPath(new URL("../../public/", import.meta.url));
  r.get(["/", "/index.html"], (_req, res, next) => res.sendFile("index.html", { root: publicDir }, (e) => e && next(e)));
  r.get("/2026-10-30-ibp-agentic-ux-wire-happy-path-v0.2.4.html", (_req, res, next) =>
    res.sendFile("2026-10-30-ibp-agentic-ux-wire-happy-path-v0.2.4.html", { root: publicDir }, (e) => e && next(e)));

  r.get("/ui", (req, res) => {
    const t = typeof req.query.tenant_id === "string" ? req.query.tenant_id : "";
    res.type("html").send(page("Home", `<form method="get" action="/ui"><label>Tenant ID
      <input name="tenant_id" size="40" value="${esc(t)}"></label> <button>Abrir</button></form>
      ${uuidRe.test(t) ? nav(t) : "<p>Informe o tenant (stub de auth W0).</p>"}
      <p>API: <code>/api/*</code> com headers <code>x-tenant-id</code> / <code>x-user-id</code>.</p>`));
  });

  r.get("/ui/:entity", async (req, res, next) => {
    try {
      const def = entityByPath.get(req.params.entity);
      const t = String(req.query.tenant_id ?? "");
      if (!def || !uuidRe.test(t)) return res.status(404).type("html").send(page("404", "<p>Não encontrado.</p>"));
      const rows = await withTenant(pool, t, (c) =>
        c.query(`SELECT * FROM ${def.table} ${def.versioned ? "WHERE is_current" : ""} ORDER BY ${def.orderBy} LIMIT 500`)
          .then((q) => q.rows.map((row) => aliasOut(def, row))));
      const cols = rows.length ? Object.keys(rows[0]).filter((k) => k !== "tenant_id") : ["id", ...(def.versioned ? ["stable_id"] : []), ...apiFields(def)];
      const fmt = (v: unknown) => (v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v);
      const table = rows.length
        ? `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows
            .map((row) => `<tr>${cols.map((c) => `<td>${esc(fmt(row[c]))}</td>`).join("")}</tr>`).join("")}</tbody></table>`
        : `<p><em>Vazio — nada cadastrado ainda neste tenant.</em></p>`;
      res.type("html").send(page(def.path, `${nav(t)}<h2>${esc(def.path)} (${rows.length})</h2>${table}`));
    } catch (e) { next(e); }
  });
  return r;
}
