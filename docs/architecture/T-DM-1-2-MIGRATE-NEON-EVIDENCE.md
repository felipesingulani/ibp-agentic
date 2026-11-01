# T-DM-1+2 — migrate Neon prod (0018) · evidência

Deivid (Arquiteto) · 2026-10-31 ~17:10 America/Sao_Paulo

- Review arch: **OK** (CHECK period YYYY-MM · CHECK qty>=0 · UNIQUE tenant/node/sku/period/source · zod ym · reimport 409 · sem backfill).
- Caminho: build Vercel (`npm run migrate && npm run seed`); box não acessa Neon:5432.
- 1ª tentativa `dpl_65ENviWYFbXidpwS4sxGQeUdVW1V` = BUILD_ERROR (faltou `-b MIGRATION_DATABASE_URL`, nada aplicado, prod não promovida).
- Deploy OK: `dpl_87QxbREJhZdskjfUoLSzZ3gSgwAm` → https://ibp-agentic-qpd79cxde-squad-401d.vercel.app (alias https://ibp-agentic.vercel.app).
- buildCommand temporário + `scripts/verify-0018-constraints.ts` (read-only); `vercel.json` restaurado para `npm run migrate && npm run seed`.

Log do build (UTC 20:09 = 17:09 America/Sao_Paulo):
```
0017_journey_land_link: already applied
0018_sales_history_period_grain_unique: applied
migrate OK
seed OK
CONSTRAINT sales_history_period_ym type=c
CONSTRAINT sales_history_qty_nonneg type=c
CONSTRAINT sales_history_tenant_node_sku_period_source_key type=u
FOUND=3/3
SALES_HISTORY_ROWS=34
VERIFY-0018 OK
```

Pós-deploy: `/` e `/?live=1` md5 `b04fef66c50f8f385cf99036ed23c825` (= public/index.html) · `/health` 200 `{"ok":true,"db":"up"}`.

Próximo: Qualidade M1–M4 (`QA-ACCEPTANCE-T-DM-1-2.md`).
