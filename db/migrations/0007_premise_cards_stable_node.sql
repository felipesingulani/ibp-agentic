-- W1 slice 1 · premise_cards.node_id → identidade estável do nó (mesmo padrão da 0006 p/ node_capacity/routes).
-- Coluna mantém o nome do contrato (`node_id`); o valor passa a ser nodes.stable_id.
-- FK composta (tenant_id, node_id) → nodes_identity(tenant_id, stable_id): impede referência cross-tenant no banco.
-- CHECK do contrato "Gap exige node_id" (premise_cards_check) é preservado (não tocado).
--
-- Também: scenario_id ganha FK composta (tenant_id, scenario_id) → scenarios(tenant_id, id) — sem isso um
-- cartão poderia apontar para cenário de outro tenant (FK simples não olha tenant; checagem de FK ignora RLS).
-- Exige UNIQUE (tenant_id, id) em scenarios (aditivo; id já é PK, então nunca conflita).
--
-- GRANTS (decisão W1 slice 1): ibp_app recebe SELECT, INSERT, UPDATE só em premise_cards (necessário p/ a
-- API de Gap card e testes). Sem DELETE (não há endpoint). scenarios, a4_runs e decision_events continuam
-- SEM grant — a validação de scenario_id é feita pela FK composta (roda como owner, sem precisar de SELECT).
-- FORCE RLS em premise_cards (não estava na 0002; agora que o app escreve nela, mesmo padrão do cadastro).

-- 1) node_id: solta FK p/ linha-versão, reescreve p/ stable_id, FK composta p/ identidade
ALTER TABLE premise_cards DROP CONSTRAINT IF EXISTS premise_cards_node_id_fkey;
UPDATE premise_cards p SET node_id = n.stable_id FROM nodes n WHERE n.id = p.node_id AND p.node_id IS DISTINCT FROM n.stable_id;
ALTER TABLE premise_cards ADD CONSTRAINT premise_cards_node_fk
  FOREIGN KEY (tenant_id, node_id) REFERENCES nodes_identity (tenant_id, stable_id);
CREATE INDEX premise_cards_node_idx ON premise_cards (tenant_id, node_id) WHERE node_id IS NOT NULL;

-- 2) scenario_id: FK composta por tenant
ALTER TABLE scenarios ADD CONSTRAINT scenarios_tenant_id_uq UNIQUE (tenant_id, id);
ALTER TABLE premise_cards DROP CONSTRAINT IF EXISTS premise_cards_scenario_id_fkey;
ALTER TABLE premise_cards ADD CONSTRAINT premise_cards_scenario_fk
  FOREIGN KEY (tenant_id, scenario_id) REFERENCES scenarios (tenant_id, id);
CREATE INDEX premise_cards_scenario_idx ON premise_cards (tenant_id, scenario_id);

-- 3) RLS forçado + grants mínimos
ALTER TABLE premise_cards FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON premise_cards TO ibp_app;
