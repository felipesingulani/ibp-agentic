-- W6 · Task 12 — harden land link (docs/architecture/W6-LAND-HARDEN-KIND-WARN-CONTRACT.md, cravos PO 2026-10-30).
-- POST /api/journey/runs/:id/land {landTenantId}: hoje a FK decide (inexistente 400 × existente 200 = oráculo de existência).
-- Agora: referência válida ⇔ o MESMO ator do lab (mesmo e-mail, case-insensitive) é `admin` no tenant alvo. Resposta uniforme:
-- false p/ inexistente / sem vínculo / ator não-admin no alvo (o motivo NÃO sai da função). O app (ibp_app, NOBYPASSRLS) não lê
-- users do alvo sob RLS → SECURITY DEFINER no padrão 0016: set_config('app.tenant_id', alvo, true) só durante a leitura e
-- restaura o lab antes de retornar. Só função (sem tabela/coluna/grant em tabela). journey_land_tenant (0016) inalterada.
-- Aditiva + idempotente (CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION journey_land_link(p_run_id uuid, p_target uuid, p_actor uuid)
RETURNS boolean   -- true = pode vincular; false = referência inválida (motivo NÃO é exposto)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_lab uuid := app_tenant_id(); v_email text; v_ok boolean;
BEGIN
  IF v_lab IS NULL THEN RAISE EXCEPTION 'journey_land_link: app.tenant_id ausente' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- journey do lab, em conviction, ainda sem land (FOR UPDATE como 0016)
  PERFORM 1 FROM journey_runs j
    WHERE j.id = p_run_id AND j.tenant_id = v_lab AND j.status = 'conviction' AND j.land_tenant_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'journey_land_link: journey não está em conviction no tenant corrente'
    USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_target IS NULL OR p_target = v_lab THEN RETURN false; END IF;      -- land_is_lab já é barrado antes no app
  SELECT u.email INTO v_email FROM users u WHERE u.id = p_actor AND u.tenant_id = v_lab;
  IF v_email IS NULL THEN RETURN false; END IF;
  -- Referência válida = o MESMO ator (mesmo e-mail) é admin no tenant alvo. Leitura sob RLS do alvo e volta ao lab.
  PERFORM set_config('app.tenant_id', p_target::text, true);
  SELECT EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = p_target AND lower(u.email) = lower(v_email) AND u.role = 'admin')
    INTO v_ok;
  PERFORM set_config('app.tenant_id', v_lab::text, true);
  RETURN coalesce(v_ok, false);
END $$;
REVOKE ALL ON FUNCTION journey_land_link(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION journey_land_link(uuid, uuid, uuid) TO ibp_app;
