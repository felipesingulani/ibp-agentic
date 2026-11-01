-- W5 · med pré-deploy (review arch Deivid 2026-10-30): journey_land_tenant() não depende mais do owner BYPASSRLS.
-- tenants/users têm FORCE RLS (id|tenant_id = app_tenant_id()); a 0015 inseria com app.tenant_id = lab e só passava porque o
-- owner (ibp) é superuser/BYPASSRLS. Agora: id do tenant novo gerado antes, app.tenant_id ← tenant novo (SET LOCAL via
-- set_config(..., true), mesmo padrão de src/db/seed.ts / src/journey/store.ts setTenant) ANTES dos INSERTs em tenants e users,
-- e restaurado p/ o lab no fim (o app segue lendo o lab na mesma transação). Assinatura, checagens slug/nome, lock da journey,
-- REVOKE/GRANT e API HTTP (201/200/409) inalterados. Aditiva + idempotente (CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION journey_land_tenant(p_run_id uuid, p_slug text, p_name text)
RETURNS TABLE (tenant_id uuid, admin_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_lab uuid := app_tenant_id(); v_t uuid := gen_random_uuid(); v_u uuid;
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
  PERFORM set_config('app.tenant_id', v_t::text, true); -- RLS do tenant novo (WITH CHECK de tenants e users)
  INSERT INTO tenants (id, slug, name) VALUES (v_t, p_slug, btrim(p_name)); -- slug UNIQUE → unique_violation (409)
  INSERT INTO users (tenant_id, email, display_name, role) VALUES (v_t, 'admin@' || p_slug || '.local', 'Admin', 'admin')
    RETURNING id INTO v_u;
  PERFORM set_config('app.tenant_id', v_lab::text, true); -- volta ao lab (store.ts lê o pack do lab logo após)
  RETURN QUERY SELECT v_t, v_u;
END $$;
REVOKE ALL ON FUNCTION journey_land_tenant(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION journey_land_tenant(uuid, text, text) TO ibp_app;
