-- W0 · Completa RLS no padrão do contrato (NOTA DEV em contracts/v0-postgres-cadastro.sql).
-- Aditivo: NÃO altera tabelas do contrato. Revisão: Deivid (Arquiteto).

CREATE POLICY tenant_isolation_tenants ON tenants
  USING (id = app_tenant_id())
  WITH CHECK (id = app_tenant_id());

CREATE POLICY tenant_isolation_users ON users
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY tenant_isolation_policies ON policies
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY tenant_isolation_node_capacity ON node_capacity
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY tenant_isolation_routes ON routes
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY tenant_isolation_skus ON skus
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY tenant_isolation_supplier_contracts ON supplier_contracts
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY tenant_isolation_sales_history ON sales_history
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY tenant_isolation_finance_drivers ON finance_drivers
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY tenant_isolation_audit_log ON audit_log
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Defesa extra: mesmo o owner da tabela respeita RLS (superuser ainda ignora — por isso o app usa role própria).
ALTER TABLE tenants            FORCE ROW LEVEL SECURITY;
ALTER TABLE users              FORCE ROW LEVEL SECURITY;
ALTER TABLE policies           FORCE ROW LEVEL SECURITY;
ALTER TABLE nodes              FORCE ROW LEVEL SECURITY;
ALTER TABLE node_capacity      FORCE ROW LEVEL SECURITY;
ALTER TABLE routes             FORCE ROW LEVEL SECURITY;
ALTER TABLE skus               FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_contracts FORCE ROW LEVEL SECURITY;
ALTER TABLE sales_history      FORCE ROW LEVEL SECURITY;
ALTER TABLE finance_drivers    FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log          FORCE ROW LEVEL SECURITY;
