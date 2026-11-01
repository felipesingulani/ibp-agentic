-- W2 · Task 6 (Wizard API, W2-WIZARD-API-CONTRACT.md): app cria/edita cenário (draft v1) pela API.
-- Só grants — sem mudança de schema (colunas do contrato bastam). FORCE RLS em scenarios já vem da 0009;
-- policy tenant_isolation_scenarios (USING + WITH CHECK tenant_id = app_tenant_id()) impede gravar p/ outro tenant.
-- Sem DELETE (cenário arquiva via status).
GRANT SELECT, INSERT, UPDATE ON scenarios TO ibp_app;
