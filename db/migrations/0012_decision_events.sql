-- W2b · Task 7 (A7 stub + decision event, contracts/decision-event.schema.json). Aditivo; não altera colunas do contrato.
-- Eventos são APPEND-ONLY: app recebe só SELECT + INSERT (sem UPDATE/DELETE).
-- 1) FKs compostas por tenant (FK simples do contrato ignora RLS → poderia apontar p/ cenário/run de outro tenant):
--    (tenant_id, scenario_id) → scenarios(tenant_id, id)
--    (tenant_id, run_id, scenario_id) → a4_runs(tenant_id, id, scenario_id): run tem de ser DO MESMO cenário (run_id NULL → não checa).
--    FKs simples do contrato ficam (não removidas).
-- 2) CHECK actor_role ∈ enum do contrato (domain_owner|sales|supply|finance|system) — NOT VALID não é necessário (tabela vazia no V0).
-- 3) FORCE RLS (policy tenant_isolation_decisions já existe: USING + WITH CHECK tenant_id = app_tenant_id()).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'a4_runs_tenant_id_scenario_uq') THEN
    ALTER TABLE a4_runs ADD CONSTRAINT a4_runs_tenant_id_scenario_uq UNIQUE (tenant_id, id, scenario_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_events_scenario_fk') THEN
    ALTER TABLE decision_events ADD CONSTRAINT decision_events_scenario_fk
      FOREIGN KEY (tenant_id, scenario_id) REFERENCES scenarios (tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_events_run_fk') THEN
    ALTER TABLE decision_events ADD CONSTRAINT decision_events_run_fk
      FOREIGN KEY (tenant_id, run_id, scenario_id) REFERENCES a4_runs (tenant_id, id, scenario_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_events_actor_role_check') THEN
    ALTER TABLE decision_events ADD CONSTRAINT decision_events_actor_role_check
      CHECK (actor_role IN ('domain_owner','sales','supply','finance','system'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS decision_events_scenario_idx ON decision_events (tenant_id, scenario_id, at);
CREATE INDEX IF NOT EXISTS decision_events_run_idx ON decision_events (tenant_id, run_id) WHERE run_id IS NOT NULL;
ALTER TABLE decision_events FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON decision_events TO ibp_app;
