-- W1c · A4 run mínimo (solver CBC open-source, processo filho). Aditivo sobre o contrato; revisão Deivid.
-- 1) status: superset do CHECK do contrato + 'queued' (POST cria queued → running → feasible|partial|failed).
--    API expõe done = feasible|partial (outcome mantido). 'discarded' preservado (invalidação por versão de cenário).
ALTER TABLE a4_runs DROP CONSTRAINT a4_runs_status_check;
ALTER TABLE a4_runs ADD CONSTRAINT a4_runs_status_check
  CHECK (status IN ('queued','running','feasible','partial','discarded','failed'));
-- 2) erro curto do run (failed/timeout) — sem stack, sem dado de outro tenant.
ALTER TABLE a4_runs ADD COLUMN IF NOT EXISTS error text;
-- 3) cenário por FK composta (tenant_id, scenario_id) — mesma regra da 0007 (cenário de outro tenant → 400).
ALTER TABLE a4_runs DROP CONSTRAINT a4_runs_scenario_id_fkey;
ALTER TABLE a4_runs ADD CONSTRAINT a4_runs_scenario_fk
  FOREIGN KEY (tenant_id, scenario_id) REFERENCES scenarios (tenant_id, id);
CREATE INDEX IF NOT EXISTS a4_runs_scenario_idx ON a4_runs (tenant_id, scenario_id, started_at DESC);
ALTER TABLE a4_runs ADD CONSTRAINT a4_runs_code_uq UNIQUE (tenant_id, run_code);
-- 4) RLS forçado + grants mínimos. scenarios: só SELECT (ler versão p/ scenarioVersion; criação de cenário segue fora).
ALTER TABLE a4_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE scenarios FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON a4_runs TO ibp_app;
GRANT SELECT ON scenarios TO ibp_app;
