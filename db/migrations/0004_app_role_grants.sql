-- W0 · Grants mínimos para a role do app (ibp_app: NOSUPERUSER, NOBYPASSRLS — criada pelo runner).
-- Escopo W0: só cadastro. Tabelas de cenário/runtime NÃO recebem grant (scenarios, premise_cards,
-- a4_runs, decision_events) — o app W0 não consegue nem ler essas tabelas.
GRANT USAGE ON SCHEMA public TO ibp_app;
GRANT SELECT ON tenants TO ibp_app;
GRANT SELECT ON users TO ibp_app;
GRANT SELECT, INSERT, UPDATE ON
  policies, nodes, node_capacity, routes, skus, supplier_contracts, finance_drivers, tenant_settings
  TO ibp_app;
GRANT SELECT, INSERT, DELETE ON sales_history TO ibp_app;
GRANT SELECT, INSERT ON audit_log TO ibp_app;          -- append-only
GRANT USAGE ON SEQUENCE audit_log_id_seq TO ibp_app;
GRANT EXECUTE ON FUNCTION app_tenant_id() TO ibp_app;
