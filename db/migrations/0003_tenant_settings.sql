-- W0 · tenant_settings (stub agnóstico de indústria). Aditivo.
-- Defaults vazios/genéricos: moeda, UoM, tipos de nó e rótulos de KPI são CONFIG do tenant,
-- nunca hardcode na API/UI. Revisão: Deivid (Arquiteto).
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id),
  currency    text,                                -- ISO 4217 (ex.: config do tenant); null = não definido
  uom         text,                                -- unidade padrão de capacidade/volume; null = não definido
  node_types  text[] NOT NULL DEFAULT '{}',        -- rótulos de tipo de nó exibidos ao usuário
  kpi_labels  jsonb  NOT NULL DEFAULT '{}',        -- { "<kpi_key>": "<label>" }
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_tenant_settings ON tenant_settings
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
