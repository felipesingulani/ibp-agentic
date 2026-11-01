-- W4 · Task 10 — execução (movimentos programados/realizados) ligada a um plano (a4_runs). docs/architecture/W4-EXECUTION-PULSE-WRITE-CONTRACT.md
-- Aditiva + idempotente. Cravos PO 2026-10-30: bucket = DIA (period_start date) · batch all-or-nothing · limiar 15% fixo (código).
-- Append-only de fato: app tem SELECT + INSERT + UPDATE só da coluna status; trigger só permite posted → void (sem DELETE).
-- FKs compostas por tenant (padrão 0012): run do MESMO cenário; nó/sku = identidade estável do MESMO tenant.
CREATE TABLE IF NOT EXISTS execution_movements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  plan_run_id      uuid NOT NULL,
  scenario_id      uuid NOT NULL,
  scenario_version int  NOT NULL,
  period_start     date NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('ship','receive','produce','transfer','other')),
  node_id          uuid NULL,
  sku_id           uuid NULL,
  qty_planned      numeric NULL CHECK (qty_planned IS NULL OR qty_planned >= 0),
  qty_actual       numeric NOT NULL CHECK (qty_actual >= 0),
  uom              text NULL,
  status           text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  source           text NOT NULL DEFAULT 'api' CHECK (source IN ('api','seed','import')),
  note             text NULL,
  at               timestamptz NOT NULL DEFAULT now(),
  actor_user_id    uuid NULL REFERENCES users(id),
  actor_role       text NULL,
  UNIQUE (tenant_id, id)
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_movements_run_fk') THEN
    ALTER TABLE execution_movements ADD CONSTRAINT execution_movements_run_fk
      FOREIGN KEY (tenant_id, plan_run_id, scenario_id) REFERENCES a4_runs (tenant_id, id, scenario_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_movements_node_fk') THEN
    ALTER TABLE execution_movements ADD CONSTRAINT execution_movements_node_fk
      FOREIGN KEY (tenant_id, node_id) REFERENCES nodes_identity (tenant_id, stable_id); -- MATCH SIMPLE: node_id NULL não checa
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_movements_sku_fk') THEN
    ALTER TABLE execution_movements ADD CONSTRAINT execution_movements_sku_fk
      FOREIGN KEY (tenant_id, sku_id) REFERENCES skus_identity (tenant_id, stable_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'execution_movements' AND policyname = 'tenant_isolation_execution') THEN
    CREATE POLICY tenant_isolation_execution ON execution_movements
      USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS execution_movements_plan_idx ON execution_movements (tenant_id, plan_run_id, period_start);
ALTER TABLE execution_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_movements FORCE ROW LEVEL SECURITY;

-- void é a ÚNICA mutação: status posted → void; nenhuma outra coluna muda (defesa além do grant por coluna).
CREATE OR REPLACE FUNCTION execution_movements_void_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'posted' OR NEW.status <> 'void'
     OR (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'execution_movements: só posted → void é permitido' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS execution_movements_void_only ON execution_movements;
CREATE TRIGGER execution_movements_void_only BEFORE UPDATE ON execution_movements
  FOR EACH ROW EXECUTE FUNCTION execution_movements_void_only();

GRANT SELECT, INSERT ON execution_movements TO ibp_app;
GRANT UPDATE (status) ON execution_movements TO ibp_app; -- só void
