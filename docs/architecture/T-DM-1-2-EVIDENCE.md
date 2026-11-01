# Evidência eng — T-DM-PERIOD-GRAIN + T-DM-SALESHIST-UQ (Devi · 2026-10-31 ~17:20 America/Sao_Paulo)

- Migration: `db/migrations/0018_sales_history_period_grain_unique.sql` (md5 `892b8b75ec042535ab7aa0a5803c8e8a`)
  - `sales_history_period_ym` CHECK `period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`
  - `sales_history_qty_nonneg` CHECK `qty >= 0`
  - `sales_history_tenant_node_sku_period_source_key` UNIQUE `(tenant_id, node_id, sku_id, period, source)`
  - Sem backfill / sem UPDATE/DELETE; falha fail-fast (ROLLBACK) se houver dado fora da regra.
- Zod: `src/domain/entities.ts` (`YM_RE` + `ym`; `qty: num.min(0)`); filtro `period_from/period_to` só `YYYY-MM` em `src/http/app.ts`.
- API: dia → 400 `validation_failed` (path `period`); qty<0 → 400; reimport → 409 `conflict` (detail = nome do UNIQUE); batch all-or-nothing.
- Testes: `test/integration/sales-history-grain.test.ts` (M1–M3, H1–H4) · `test/unit/sales-history-grain.test.ts` (zod ≡ CHECK) · `a1-curva.test.ts` sem linha diária. `npm test` 169/0 · typecheck OK · gate OK. Log: `T-DM-1-2-test.log`.
- Audit: `npm run audit:sales-history-period`. Prod pré (Deivid): `TOTAL_ROWS=34 · PERIOD_LEN_NE_7=0 · PERIOD_YM_OK=34 · DUP_GROUPS=0`.
- Migrate Neon prod: **pendente** (Deivid via build). UI `public/index.html` md5 `b04fef66…` intocada.
