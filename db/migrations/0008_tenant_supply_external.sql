-- W1b · Prontidão A4: flag de escopo do tenant "supply externo (compra de terceiros)".
-- Wire shell v0.3.1: contrato de fornecedor só é exigido p/ o A4 se supply externo estiver no escopo (toggle).
-- Aditivo; default false → item "contrato" sai como n/a até o tenant ligar o flag (PUT /api/tenant-settings).
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS supply_external_in_scope boolean NOT NULL DEFAULT false;
