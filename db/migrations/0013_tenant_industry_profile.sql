-- W3b · Task 9 (docs/architecture/W3B-CADASTRO-WRITE-API-CONTRACT.md). Aditivo: só colunas em tenant_settings.
-- Pack de indústria (profile_id; NULL = legado ≡ generic, cravo PO 1), labels de entidade, aliases de policies.kind
-- (policy_kinds; "pack inclui alçada" ≡ policy_kinds ? 'alcada') e roster A1–A7 (config exibida, não liga endpoints).
-- Sem enum de pack no banco (API valida contra packs/), sem grant novo (ibp_app já tem SELECT/INSERT/UPDATE, 0004),
-- sem tabela/trigger. FORCE RLS + policy tenant_isolation_tenant_settings (0003) intactas. Idempotente.
ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS industry_pack text NULL,
  ADD COLUMN IF NOT EXISTS entity_labels jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS policy_kinds  jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS agent_roster  jsonb NOT NULL DEFAULT '{}';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_settings_pack_nonempty') THEN
    ALTER TABLE tenant_settings ADD CONSTRAINT tenant_settings_pack_nonempty
      CHECK (industry_pack IS NULL OR length(btrim(industry_pack)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_settings_jsonb_objects') THEN
    ALTER TABLE tenant_settings ADD CONSTRAINT tenant_settings_jsonb_objects
      CHECK (jsonb_typeof(entity_labels) = 'object' AND jsonb_typeof(policy_kinds) = 'object'
             AND jsonb_typeof(agent_roster) = 'object');
  END IF;
END $$;
