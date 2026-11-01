-- W1 · confirmed_at (Deivid + PO): momento em que o tenant confirmou o cadastro p/ cenários.
-- Unlock "Novo cenário" (UX, Didi v0.3.2) = confirmed_at IS NOT NULL AND a4_readiness.state ≠ block.
-- NÃO entra no `state` da prontidão. Aditivo; NULL = não confirmado. Gravado só pelo servidor (now()) via
-- PUT /api/tenant-settings {confirmed: true|false}.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS confirmed_at timestamptz NULL;
