-- IBP Agentic V0 — Postgres cadastro / master data (§5 put spec)
-- 2026-10-30 · Deivid (Arquiteto)
-- Multi-tenant lógico + RLS; versionamento de objetos de domínio; sem write-back.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── tenancy & auth ───────────────────────────────────────────
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  email       text NOT NULL,
  display_name text,
  role        text NOT NULL CHECK (role IN ('domain_owner','sales','supply','finance','admin')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- ─── helper: scoped versioned object ──────────────────────────
-- Cada entidade de domínio versionável: (tenant_id, business_key, version)
-- version sobe em edição; leitura runtime usa "current" via view ou flag.

-- ─── 5.1 Policies ─────────────────────────────────────────────
CREATE TABLE policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  kind          text NOT NULL CHECK (kind IN ('estoque','working_capital','servico','escalonamento')),
  name          text NOT NULL,
  version       int  NOT NULL DEFAULT 1 CHECK (version >= 1),
  is_current    boolean NOT NULL DEFAULT true,
  body          jsonb NOT NULL DEFAULT '{}',  -- cobertura, min/max, OTIF, DSI, alçadas, etc.
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, name, version)
);

-- ─── 5.2 Network & capacity ───────────────────────────────────
CREATE TABLE nodes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  code          text NOT NULL,               -- FL-CPS, CD3
  name          text NOT NULL,
  node_type     text NOT NULL CHECK (node_type IN ('filial','cd','planta','outro')),
  version       int  NOT NULL DEFAULT 1,
  is_current    boolean NOT NULL DEFAULT true,
  attrs         jsonb NOT NULL DEFAULT '{}', -- geo, calendário ref
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code, version)
);

CREATE TABLE node_capacity (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  node_id       uuid NOT NULL REFERENCES nodes(id),
  version       int  NOT NULL DEFAULT 1,
  is_current    boolean NOT NULL DEFAULT true,
  capacity_t_month numeric,
  capacity_extra    numeric,
  calendar      jsonb NOT NULL DEFAULT '{}', -- indisponibilidades
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── 5.3 Logistics ────────────────────────────────────────────
CREATE TABLE routes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  code          text NOT NULL,               -- R-14
  origin_node_id uuid NOT NULL REFERENCES nodes(id),
  dest_node_id  uuid NOT NULL REFERENCES nodes(id),
  mode          text,
  version       int  NOT NULL DEFAULT 1,
  is_current    boolean NOT NULL DEFAULT true,
  lead_time_days numeric,
  cost_per_ton  numeric,
  windows       jsonb NOT NULL DEFAULT '[]', -- janelas de entrega
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code, version)
);

-- ─── 5.4 Products & costs ─────────────────────────────────────
CREATE TABLE skus (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  code          text NOT NULL,
  name          text NOT NULL,
  family        text,
  version       int  NOT NULL DEFAULT 1,
  is_current    boolean NOT NULL DEFAULT true,
  unit_cost     numeric,
  attrs         jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code, version)
);

-- ─── 5.5 Supplier contracts ───────────────────────────────────
CREATE TABLE supplier_contracts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  code          text NOT NULL,
  supplier_group text NOT NULL,
  version       int  NOT NULL DEFAULT 1,
  is_current    boolean NOT NULL DEFAULT true,
  obligations   jsonb NOT NULL DEFAULT '{}', -- min volume, take-or-pay, janelas, penalidades
  sku_ids       uuid[] NOT NULL DEFAULT '{}',
  valid_from    date,
  valid_to      date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code, version)
);

-- ─── 5.6 Sales & history ──────────────────────────────────────
CREATE TABLE sales_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  node_id       uuid NOT NULL REFERENCES nodes(id),
  sku_id        uuid NOT NULL REFERENCES skus(id),
  period        text NOT NULL,               -- YYYY-MM ou YYYY-MM-DD
  qty           numeric NOT NULL,
  revenue       numeric,
  source        text NOT NULL DEFAULT 'extract',
  ingested_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_history_lookup ON sales_history (tenant_id, node_id, sku_id, period);

-- ─── 5.7 Finance drivers ──────────────────────────────────────
CREATE TABLE finance_drivers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  version       int  NOT NULL DEFAULT 1,
  is_current    boolean NOT NULL DEFAULT true,
  mapping       jsonb NOT NULL DEFAULT '{}', -- volume/preço/prazo/invest → caixa, margem, DIO
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── scenarios / premises / A4 / decisions (runtime, refs contracts JSON) ─
CREATE TABLE scenarios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  code          text NOT NULL,               -- SCN-0142
  name          text NOT NULL,
  version       int  NOT NULL DEFAULT 1,
  is_current    boolean NOT NULL DEFAULT true,
  leg           text CHECK (leg IN ('sales','supply','finance','composed')),
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','ready','stale','archived')),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code, version)
);

CREATE TABLE premise_cards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  scenario_id   uuid NOT NULL REFERENCES scenarios(id),
  card_id       text NOT NULL,               -- PC-0142-04
  type          text NOT NULL CHECK (type IN ('NovaFilial','CurvaDemanda','Investimento','Gap')),
  fields        jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL CHECK (status IN ('ok','gap')),
  node_id       uuid REFERENCES nodes(id),   -- obrigatório na app se type=Gap
  version       int  NOT NULL DEFAULT 1,
  source        text NOT NULL CHECK (source IN ('ditado','edit')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (type <> 'Gap' OR node_id IS NOT NULL)
);

CREATE TABLE a4_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  run_code      text NOT NULL,
  scenario_id   uuid NOT NULL REFERENCES scenarios(id),
  scenario_version int NOT NULL,
  status        text NOT NULL CHECK (status IN ('running','feasible','partial','discarded','failed')),
  reasons       jsonb NOT NULL DEFAULT '[]',      -- A4Reason[≤3]
  counts_by_kind jsonb NOT NULL DEFAULT '{}',     -- countsByKind
  plan          jsonb,                             -- plano resumido
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE TABLE decision_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  scenario_id   uuid NOT NULL REFERENCES scenarios(id),
  scenario_version int NOT NULL,
  run_id        uuid REFERENCES a4_runs(id),
  action        text NOT NULL CHECK (action IN ('approve','escalate')),
  why           text NOT NULL CHECK (length(why) > 0),
  actor_user_id uuid REFERENCES users(id),
  actor_role    text NOT NULL,
  export_ref    text,
  at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  at            timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_role    text,
  action        text NOT NULL,
  entity        text,
  entity_id     text,
  payload       jsonb NOT NULL DEFAULT '{}'
);

-- ─── RLS (skeleton): toda query filtra tenant ─────────────────
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE skus ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE premise_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE a4_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- App deve SET app.tenant_id = '<uuid>' por request.
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Exemplo de policy (repetir padrão nas demais tabelas com tenant_id):
CREATE POLICY tenant_isolation_nodes ON nodes
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY tenant_isolation_scenarios ON scenarios
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY tenant_isolation_premise ON premise_cards
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY tenant_isolation_a4 ON a4_runs
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY tenant_isolation_decisions ON decision_events
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- NOTA DEV: aplicar o mesmo padrão de policy em policies, node_capacity, routes,
-- skus, supplier_contracts, sales_history, finance_drivers, users, audit_log.
-- Secrets/API keys nunca nesta base; PII mínima; não logar ditado bruto com dado sensível no LLM cache.
