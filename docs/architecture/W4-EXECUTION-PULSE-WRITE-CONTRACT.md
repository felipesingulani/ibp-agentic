# Task 10 — W4 Execution pulse write (contrato arquitetura)

Status: **aprovado Deivid + PO · eng Task 10 green** (dia / all-or-nothing / 15%; UPDATE só status · 2026-10-30) · wire alvo: shell **v0.3.6+** (Pulse programado vs plano) · implementação: Devi (após F1 + green Task 9)

## Objetivo V0
Fechar o buraco do W3: **gravar execução** (movimentações programadas / realizadas) e fazer o Pulse mostrar **programado vs plano** com exceções derivadas de dado real — não seed de wire. §7.5 put spec · metabolic rate insight→decisão→ação.

Sem LLM (A6 continua regra determinística), sem write-back ERP, sem solver novo.

## Pré-requisitos
- Task 7–9 green: `decision_events`, Pulse/Visões GETs, pack/alcada em `tenant_settings`.
- `planRef` W3 (`approved > latest_run > none`) — execução ancora no plano **aprovado** quando existir; sem approve → write permitido mas exceptions marcam `plan_basis=latest_run|none`.
- Grants: **mínimos novos** só na tabela de execução (SELECT/INSERT; UPDATE só status cancel se PO cravar).

## Migration `0014_execution_pulse.sql` (aditiva)

```sql
-- Append-ish: linhas de execução ligadas a um plano (run) e opcionalmente a nó/rota/sku.
CREATE TABLE IF NOT EXISTS execution_movements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  plan_run_id     uuid NOT NULL,          -- a4_runs.id do plano de referência
  scenario_id     uuid NOT NULL,
  scenario_version int NOT NULL,
  period_start    date NOT NULL,          -- bucket = dia (cravado PO)
  kind            text NOT NULL CHECK (kind IN ('ship','receive','produce','transfer','other')),
  node_id         uuid NULL,              -- stable_id de nodes_identity (opcional)
  sku_id          uuid NULL,
  qty_planned     numeric NULL,           -- espelho do plano no bucket (pode vir null se só actual)
  qty_actual      numeric NOT NULL,
  uom             text NULL,
  status          text NOT NULL DEFAULT 'posted'
                    CHECK (status IN ('posted','void')),
  source          text NOT NULL DEFAULT 'api' CHECK (source IN ('api','seed','import')),
  note            text NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid NULL,
  actor_role      text NULL,
  UNIQUE (tenant_id, id)
);
-- FKs compostas (mesmo padrão 0012):
-- (tenant_id, plan_run_id, scenario_id) → a4_runs(tenant_id, id, scenario_id)
-- (tenant_id, node_id) → nodes_identity quando node_id NOT NULL
CREATE INDEX IF NOT EXISTS execution_movements_plan_idx
  ON execution_movements (tenant_id, plan_run_id, period_start);
ALTER TABLE execution_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_movements FORCE ROW LEVEL SECURITY;
-- policy tenant_isolation_* USING/WITH CHECK app_tenant_id()
GRANT SELECT, INSERT ON execution_movements TO ibp_app;
GRANT UPDATE (status) ON execution_movements TO ibp_app;  -- só void; + trigger posted→void (eng Task 10)
```

Sem tabela de “alertas” separada na V0: exceptions = **projeção** (plano × movimentos + reasons A4 + alcada), como W3, agora com fonte `execution`.

## Endpoints (tenant header + RLS)

| Método | Path | Notas |
|--------|------|--------|
| `POST` | `/api/execution/movements` | body `{ planRunId, periodStart, kind, qtyActual, qtyPlanned?, nodeId?, skuId?, note? }` → 1 linha `posted`. `400` se run inexistente/cross-tenant; `409 plan_run_mismatch` se scenario do run ≠ body implícito. Audit em `audit_log`. |
| `POST` | `/api/execution/movements:batch` | até N=100; mesma tx + advisory lock tenant. **All-or-nothing** (cravado PO): qualquer rejeição → rollback; sem 207 no V0. |
| `POST` | `/api/execution/movements/:id/void` | `status=void` + why ≥1 (append-only de fato: não DELETE). |
| `GET` | `/api/execution/movements` | query `?planRunId&from&to&kind` — lista posted. |
| `GET` | `/api/pulse/summary` | **estende** W3: se há movimentos no `planRef`, `pending.executionExceptions` + opcional KPI aderência (`adherence` = 1 − Σ|actual−planned|/Σplanned no horizonte curto; `null` + `no_data` se sem movimentos). |
| `GET` | `/api/pulse/exceptions` | **estende** W3: nova fonte `execution` — buckets com \|actual−planned\|/planned **>** limiar **fixo 0.15** (cravado PO: 15% exato = quiet) V0 (settings/pack depois) → severity `warn`; planned>0 e actual=0 → `block`. `kind` ∈ enum `a4-reason` (`outro`/`capacidade`/`contrato`/`custo`/`janela` — mapear ship delay → `janela`). |

Wizard/Cadastro **não** mudam. Re-otimizar / novo cenário a partir de exceção = CTA UI → Task 6 (fora criar auto-scenario).

## Regras
1. **Nunca inventar número.** Sem movimentos → exceptions `execution` vazias; adherence `null`/`no_data`.
2. **Âncora de plano:** preferir `planRef.basis=approved`; se writer manda `planRunId` de run não aprovado, aceita mas tag `unapproved_plan` no item.
3. **Void ≠ delete.** Histórico preservado; GET default filtra `posted`. App: `GRANT UPDATE (status)` + trigger só `posted→void` (qty/DELETE/void→posted barrados) — **aprovado** vs UPDATE genérico do rascunho.
4. **LLM zero.** Gate W4 = W3 + DENY fetch/LLM em `src/http/execution*` / `src/execution*`.
5. **RLS** FORCE + FKs compostas; tenant B nunca vê movimentos de A.
6. Contratos: opcional `contracts/execution-movement.schema.json` (ajv); **não** alterar enums PremiseCard/DecisionEvent.

## DoD
- [ ] 0014 aplica/reaplica; FORCE RLS; grant mínimo; W0–W9 verdes
- [ ] POST movement + batch; void com why; GET lista
- [ ] Pulse exceptions inclui fonte `execution` com limiar; empty tenant sem inventar
- [ ] summary.adherence null sem dados; número real com movimentos
- [ ] RLS cross-tenant; gate W4 verde; curl evidence
- [ ] Qualidade: seed sample com 2–3 movimentos vs plano aprovado → warn/block visíveis no Pulse

## Fora
- A6 agente / LLM prose; auto re-scenario; write-back ERP/TMS
- Multi-período estoque/WC; sparklines históricos longos
- Import CSV/SFTP (só `source=api|seed` V0)
- RBAC fino (Finance vs Supply no POST)

## Cravos PO (2026-10-30) — **cravados**
1. Bucket **dia**.
2. Batch **all-or-nothing** (sem 207).
3. Limiar **15% fixo** V0 com comparação **`> 0.15`** (15% exato = quiet) — cravado PO 2026-10-30 (API+QA mandam).

## Cravos (proposta inicial → decisão)
Proposta inicial sugeria semana; **PO cravou dia**. Batch e limiar seguiram a recomendação (all-or-nothing / 15% fixo).
