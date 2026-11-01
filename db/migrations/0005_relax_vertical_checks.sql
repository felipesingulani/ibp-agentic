-- W0.1 · Remove CHECKs com vocabulário de vertical (decisão Deivid, 2026-10-30).
-- nodes.node_type e policies.kind viram text livre (NOT NULL mantido); a API valida
-- node_type contra tenant_settings.node_types (se não vazio). Aditivo / não destrutivo de dados.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS tbl
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.contype = 'c'
       AND ((c.conrelid = 'public.nodes'::regclass    AND a.attname = 'node_type')
         OR (c.conrelid = 'public.policies'::regclass AND a.attname = 'kind'))
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

-- Mantém a garantia mínima agnóstica: não vazio.
ALTER TABLE nodes    ADD CONSTRAINT nodes_node_type_nonempty CHECK (length(btrim(node_type)) > 0);
ALTER TABLE policies ADD CONSTRAINT policies_kind_nonempty   CHECK (length(btrim(kind)) > 0);
