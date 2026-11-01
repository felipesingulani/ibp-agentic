-- W5 · Task 11 — Journey D3 (learning journey → conviction pack → land). docs/architecture/W5-JOURNEY-D3-CONTRACT.md
-- Aditiva + idempotente. Cravos PO 2026-10-30: journey vive no tenant LAB (RLS por tenant_id) · land cria tenant thin se
-- landTenantId omitido (409 se slug colidir) · conviction = JSON+MD em disco + GET download.
CREATE TABLE IF NOT EXISTS journey_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  code           text NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','conviction','landed','abandoned')),
  sponsor_role   text NULL,
  scope          jsonb NOT NULL DEFAULT '{}',
  steps          jsonb NOT NULL DEFAULT '[]',
  leverage       jsonb NOT NULL DEFAULT '{}',
  conviction_ref text NULL,
  land_tenant_id uuid NULL REFERENCES tenants(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS journey_runs_status_idx ON journey_runs (tenant_id, status);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'journey_runs' AND policyname = 'tenant_isolation_journey') THEN
    CREATE POLICY tenant_isolation_journey ON journey_runs
      USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
  END IF;
END $$;
ALTER TABLE journey_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE journey_runs FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON journey_runs TO ibp_app; -- sem DELETE (abandon = status)

-- Land thin (cravo PO 1): o app NÃO tem INSERT em tenants/users. Única porta = esta função SECURITY DEFINER, amarrada a uma
-- journey do tenant corrente (app.tenant_id) em status 'conviction' e ainda sem land. Cria tenant + 1 usuário admin; nada mais
-- (tenant_settings + pack default são escritos pelo app sob RLS do tenant novo, mesmo caminho do POST /api/cadastro/pack).
CREATE OR REPLACE FUNCTION journey_land_tenant(p_run_id uuid, p_slug text, p_name text)
RETURNS TABLE (tenant_id uuid, admin_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_lab uuid := app_tenant_id(); v_t uuid; v_u uuid;
BEGIN
  IF v_lab IS NULL THEN RAISE EXCEPTION 'journey_land_tenant: app.tenant_id ausente' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' THEN
    RAISE EXCEPTION 'journey_land_tenant: slug inválido' USING ERRCODE = 'check_violation';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) = 0 OR length(p_name) > 120 THEN
    RAISE EXCEPTION 'journey_land_tenant: nome inválido' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM journey_runs j
    WHERE j.id = p_run_id AND j.tenant_id = v_lab AND j.status = 'conviction' AND j.land_tenant_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journey_land_tenant: journey não está em conviction no tenant corrente' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO tenants (slug, name) VALUES (p_slug, btrim(p_name)) RETURNING id INTO v_t; -- slug UNIQUE → unique_violation (409)
  INSERT INTO users (tenant_id, email, display_name, role) VALUES (v_t, 'admin@' || p_slug || '.local', 'Admin', 'admin')
    RETURNING id INTO v_u;
  RETURN QUERY SELECT v_t, v_u;
END $$;
REVOKE ALL ON FUNCTION journey_land_tenant(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION journey_land_tenant(uuid, text, text) TO ibp_app;
