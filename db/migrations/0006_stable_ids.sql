-- W0.1 · Identidade estável entre versões (decisão Deivid, prioridade alta).
-- Toda entidade versionada ganha `stable_id` (compartilhado por todas as versões; v1 usa stable_id = id).
-- FKs de cadastro (node_capacity, routes, sales_history) passam a apontar para a IDENTIDADE
-- (tenant_id, stable_id) em tabelas *_identity — FK composta impede referência cross-tenant no banco.
-- As colunas mantêm o nome do contrato (node_id, sku_id, origin_node_id, dest_node_id), mas o valor
-- agora é o stable_id. supplier_contracts.sku_ids[] também passa a guardar stable_ids (validado na API).
-- Fora do escopo: premise_cards.node_id (tabela de cenário, W0 não toca) continua → nodes(id).

-- 1) coluna stable_id + backfill (lineage = mesma business key no tenant; stable_id = id da 1ª versão)
ALTER TABLE policies           ADD COLUMN stable_id uuid;
ALTER TABLE nodes              ADD COLUMN stable_id uuid;
ALTER TABLE node_capacity      ADD COLUMN stable_id uuid;
ALTER TABLE routes             ADD COLUMN stable_id uuid;
ALTER TABLE skus               ADD COLUMN stable_id uuid;
ALTER TABLE supplier_contracts ADD COLUMN stable_id uuid;
ALTER TABLE finance_drivers    ADD COLUMN stable_id uuid;

UPDATE policies t SET stable_id = s.sid FROM (
  SELECT id, first_value(id) OVER (PARTITION BY tenant_id, kind, name ORDER BY version, created_at) sid FROM policies) s
  WHERE t.id = s.id;
UPDATE nodes t SET stable_id = s.sid FROM (
  SELECT id, first_value(id) OVER (PARTITION BY tenant_id, code ORDER BY version, created_at) sid FROM nodes) s
  WHERE t.id = s.id;
UPDATE routes t SET stable_id = s.sid FROM (
  SELECT id, first_value(id) OVER (PARTITION BY tenant_id, code ORDER BY version, created_at) sid FROM routes) s
  WHERE t.id = s.id;
UPDATE skus t SET stable_id = s.sid FROM (
  SELECT id, first_value(id) OVER (PARTITION BY tenant_id, code ORDER BY version, created_at) sid FROM skus) s
  WHERE t.id = s.id;
UPDATE supplier_contracts t SET stable_id = s.sid FROM (
  SELECT id, first_value(id) OVER (PARTITION BY tenant_id, code ORDER BY version, created_at) sid FROM supplier_contracts) s
  WHERE t.id = s.id;
UPDATE finance_drivers t SET stable_id = s.sid FROM (
  SELECT id, first_value(id) OVER (PARTITION BY tenant_id ORDER BY version, created_at) sid FROM finance_drivers) s
  WHERE t.id = s.id;
-- node_capacity: lineage pela linha-versão de nó referenciada (antes de reescrever a FK)
UPDATE node_capacity t SET stable_id = s.sid FROM (
  SELECT id, first_value(id) OVER (PARTITION BY tenant_id, node_id ORDER BY version, created_at) sid FROM node_capacity) s
  WHERE t.id = s.id;

-- 2) tabelas de identidade (alvo das FKs) para entidades referenciadas
CREATE TABLE nodes_identity (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  stable_id  uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, stable_id)
);
CREATE TABLE skus_identity (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  stable_id  uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, stable_id)
);
INSERT INTO nodes_identity (tenant_id, stable_id) SELECT DISTINCT tenant_id, stable_id FROM nodes;
INSERT INTO skus_identity  (tenant_id, stable_id) SELECT DISTINCT tenant_id, stable_id FROM skus;

ALTER TABLE nodes_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE nodes_identity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_nodes_identity ON nodes_identity
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE skus_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE skus_identity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_skus_identity ON skus_identity
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- identidade criada automaticamente ao inserir qualquer versão (roda como o invoker → RLS vale)
CREATE FUNCTION ensure_nodes_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO nodes_identity (tenant_id, stable_id) VALUES (NEW.tenant_id, NEW.stable_id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE FUNCTION ensure_skus_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO skus_identity (tenant_id, stable_id) VALUES (NEW.tenant_id, NEW.stable_id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

-- 3) stable_id obrigatório; default p/ inserts diretos; 1 versão corrente por identidade
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['policies','nodes','node_capacity','routes','skus','supplier_contracts','finance_drivers'] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN stable_id SET DEFAULT gen_random_uuid()', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN stable_id SET NOT NULL', t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id, stable_id, version)', t, t || '_stable_version_uq');
    EXECUTE format('CREATE UNIQUE INDEX %I ON %I (tenant_id, stable_id) WHERE is_current', t || '_one_current_uq', t);
  END LOOP;
END $$;

CREATE TRIGGER nodes_identity_ins BEFORE INSERT ON nodes FOR EACH ROW EXECUTE FUNCTION ensure_nodes_identity();
CREATE TRIGGER skus_identity_ins  BEFORE INSERT ON skus  FOR EACH ROW EXECUTE FUNCTION ensure_skus_identity();
ALTER TABLE nodes ADD CONSTRAINT nodes_identity_fk FOREIGN KEY (tenant_id, stable_id) REFERENCES nodes_identity (tenant_id, stable_id);
ALTER TABLE skus  ADD CONSTRAINT skus_identity_fk  FOREIGN KEY (tenant_id, stable_id) REFERENCES skus_identity  (tenant_id, stable_id);

-- 4) reescreve FKs: linha-versão → stable_id; FK composta (tenant_id, stable_id)
ALTER TABLE node_capacity DROP CONSTRAINT IF EXISTS node_capacity_node_id_fkey;
ALTER TABLE routes        DROP CONSTRAINT IF EXISTS routes_origin_node_id_fkey;
ALTER TABLE routes        DROP CONSTRAINT IF EXISTS routes_dest_node_id_fkey;
ALTER TABLE sales_history DROP CONSTRAINT IF EXISTS sales_history_node_id_fkey;
ALTER TABLE sales_history DROP CONSTRAINT IF EXISTS sales_history_sku_id_fkey;

UPDATE node_capacity t SET node_id        = n.stable_id FROM nodes n WHERE n.id = t.node_id;
UPDATE routes        t SET origin_node_id = n.stable_id FROM nodes n WHERE n.id = t.origin_node_id;
UPDATE routes        t SET dest_node_id   = n.stable_id FROM nodes n WHERE n.id = t.dest_node_id;
UPDATE sales_history t SET node_id        = n.stable_id FROM nodes n WHERE n.id = t.node_id;
UPDATE sales_history t SET sku_id         = s.stable_id FROM skus  s WHERE s.id = t.sku_id;
UPDATE supplier_contracts t SET sku_ids = ARRAY(
  SELECT COALESCE(s.stable_id, u.x) FROM unnest(t.sku_ids) WITH ORDINALITY AS u(x, o)
    LEFT JOIN skus s ON s.id = u.x ORDER BY u.o)
  WHERE cardinality(t.sku_ids) > 0;

ALTER TABLE node_capacity ADD CONSTRAINT node_capacity_node_fk
  FOREIGN KEY (tenant_id, node_id) REFERENCES nodes_identity (tenant_id, stable_id);
ALTER TABLE routes ADD CONSTRAINT routes_origin_node_fk
  FOREIGN KEY (tenant_id, origin_node_id) REFERENCES nodes_identity (tenant_id, stable_id);
ALTER TABLE routes ADD CONSTRAINT routes_dest_node_fk
  FOREIGN KEY (tenant_id, dest_node_id) REFERENCES nodes_identity (tenant_id, stable_id);
ALTER TABLE sales_history ADD CONSTRAINT sales_history_node_fk
  FOREIGN KEY (tenant_id, node_id) REFERENCES nodes_identity (tenant_id, stable_id);
ALTER TABLE sales_history ADD CONSTRAINT sales_history_sku_fk
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus_identity (tenant_id, stable_id);

CREATE INDEX node_capacity_node_idx ON node_capacity (tenant_id, node_id) WHERE is_current;
CREATE INDEX routes_origin_idx      ON routes (tenant_id, origin_node_id);
CREATE INDEX routes_dest_idx        ON routes (tenant_id, dest_node_id);

-- 5) grants (role do app)
GRANT SELECT, INSERT ON nodes_identity, skus_identity TO ibp_app;
