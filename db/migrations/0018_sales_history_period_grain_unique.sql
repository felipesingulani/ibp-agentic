-- T-DM-PERIOD-GRAIN + T-DM-SALESHIST-UQ (High 1+2 · opção A V0 · PO 2026-10-31).
-- Pré-migrate audit prod (scripts/audit-sales-history-period.ts): TOTAL_ROWS=34 · PERIOD_LEN_NE_7=0 ·
-- PERIOD_YM_OK=34 · DUP_GROUPS=0 → sem backfill / sem rewrite de dados. Aditivo: se houver linha fora da
-- regra, o ADD CONSTRAINT falha e a transação do runner faz ROLLBACK (fail-fast, nunca corrige dado).
-- V1 (fora deste escopo): period_start date + grain (como execution_movements).

-- 1) period só mês YYYY-MM (≡ zod `ym` em src/domain/entities.ts)
ALTER TABLE sales_history ADD CONSTRAINT sales_history_period_ym
  CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- 2) qty não negativa (qty = 0 permitido)
ALTER TABLE sales_history ADD CONSTRAINT sales_history_qty_nonneg
  CHECK (qty >= 0);

-- 3) uma linha por (tenant, nó, SKU, mês, origem) — reimport da mesma chave → 23505 → API 409 (strict, sem upsert V0).
--    source é NOT NULL DEFAULT 'extract' no contrato → sem coalesce. node_id/sku_id = stable_id (0006).
ALTER TABLE sales_history ADD CONSTRAINT sales_history_tenant_node_sku_period_source_key
  UNIQUE (tenant_id, node_id, sku_id, period, source);
