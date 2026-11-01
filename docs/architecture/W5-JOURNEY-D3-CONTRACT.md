# Task 11 — W5 Journey D3 productization (contrato arquitetura)

Status: **aprovado Deivid + PO** (cravos cria-tenant / lab-tenant / GET conviction · 2026-10-30) · put spec §7.6 · wave W5 · implementação: Devi (após green Task 10)

## Objetivo V0
Productizar a **learning journey** (Rewired D3) como motion de venda/filtro — **não** o P&L core. Entrega repetível:

1. Leverage points em $ (WC / serviço / expedite) — números do Pulse/`planRef` quando existirem; senão `null` + checklist.
2. Latência / qualidade do consenso (proxy V0: contagem de DecisionEvents + tempo entre escalate→approve).
3. Role clarity (domain owner + Sales/Supply/Finance) — roster do pack + gaps de papel.
4. **Conviction pack** → **land** do OS num escopo (BU / rede / famílias).

Mesmo vocabulário do OS (cenário, alçada, Pulse, Visões). Sem LLM prose na V0 (templates determinísticos).

## Pré-requisitos
- Task 8–10 green (Pulse/Visões, pack/alcada, execution).
- Packs + `tenant_settings` (0013). Tenant demo pode ser o “lab” da journey.

## Migration `0015_journey_d3.sql` (aditiva)

```sql
CREATE TABLE IF NOT EXISTS journey_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),  -- lab tenant (pode ser demo)
  code          text NOT NULL,                         -- JR-…
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','conviction','landed','abandoned')),
  sponsor_role  text NULL,                             -- domain_owner|finance|…
  scope         jsonb NOT NULL DEFAULT '{}',           -- {bu?, nodeStableIds[], skuFamilies[]}
  steps         jsonb NOT NULL DEFAULT '[]',           -- [{id, status, at, notes}]
  leverage      jsonb NOT NULL DEFAULT '{}',           -- snapshots tipados (pode ter nulls)
  conviction_ref text NULL,                            -- path/id do pack exportado
  land_tenant_id uuid NULL REFERENCES tenants(id),     -- tenant “de verdade” após land
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
-- RLS FORCE + policy tenant_isolation; GRANT SELECT, INSERT, UPDATE TO ibp_app
CREATE INDEX IF NOT EXISTS journey_runs_status_idx ON journey_runs (tenant_id, status);
```

Sem tabela de “slides”; conviction pack = artefato gerado (JSON + markdown) em storage local/path (`export_ref` style).

## Endpoints

| Método | Path | Notas |
|--------|------|--------|
| `POST` | `/api/journey/runs` | `{ code?, scope?, sponsorRole? }` → `open` |
| `GET` | `/api/journey/runs` · `/:id` | lista / detalhe |
| `POST` | `/api/journey/runs/:id/steps/:stepId/complete` | `{ notes? }` — steps fixos V0: `leverage` · `consensus` · `roles` · `conviction` |
| `POST` | `/api/journey/runs/:id/snapshot` | puxa leverage/consensus do Pulse/`planRef` do tenant lab (sem inventar) |
| `POST` | `/api/journey/runs/:id/conviction` | gera pack (JSON+MD) → `status=conviction` + `conviction_ref` |
| `POST` | `/api/journey/runs/:id/land` | `{ landTenantId? }` — **cravado:** se omitido, **cria tenant thin** + pack default; `status=landed`. Não copia execução. |
| `GET` | `/api/journey/runs/:id/conviction` | Download do pack (JSON+MD); 404 se ainda não gerado. |

## Regras
1. **Nunca inventar $.** Leverage sem plano → campos `null` + `nullReason` (igual W3).
2. **LLM zero.** Textos do conviction pack = templates pt-BR + números snapshot.
3. **Land ≠ write-back ERP.** Só provisiona tenant/OS.
4. Gate W5: DENY fetch/LLM em `src/http/journey*` / `src/journey*`.
5. RLS: journey do tenant lab; `land_tenant_id` cross-ref só id (sem ler dados do land sem header certo).

## DoD
- [ ] 0015 + RLS + grants; W0–W4 verdes
- [ ] CRUD journey + 4 steps + snapshot sem inventar
- [ ] conviction gera artefato legível; land cria/liga tenant
- [ ] Qualidade: happy lab → conviction → land; empty lab sem números falsos

## Fora
- Billing/fee cohort; PDF polish; slides Keynote
- Auto-diagnóstico LLM; multi-empresa cohort UI rica
- W6 write-back / harden

## Cravos PO (2026-10-30) — **cravados**
1. Land **cria tenant thin** se `landTenantId` omitido.
2. Journey vive no **tenant lab** (RLS).
3. Conviction: path + **`GET /api/journey/runs/:id/conviction`**.

## Cravos PO (proposta)
1. Land **cria tenant novo** por default ou só liga a um existente? (recomendo: cria thin se omitido; 409 se code colidir.)
2. Journey vive no tenant **demo/lab** ou tabela global sem tenant? (recomendo: no tenant lab — RLS simples.)
3. Conviction pack: só JSON+MD no disco V0, ou também `GET` download? (recomendo: path + `GET /api/journey/runs/:id/conviction`.)
