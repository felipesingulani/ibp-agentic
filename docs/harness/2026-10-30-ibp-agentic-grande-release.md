# IBP Agentic — Grande Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar o Domain Rewire OS / IBP Agentic (Cadastro · Pulse/Caixa · Visões · Cenários+wizard · A4 optimizer) alinhado à put spec e ao shell UX v0.3.1.

**Architecture:** App Node/Express + Postgres multi-tenant (`/workspace/ibp-agentic`); master data versionado com `stable_id`; A4 = OR-Tools (não-LLM); A1–A3 = LLM intent→cartões tipados; A7 = state machine. Wizard = fluxo aninhado em Cenários.

**Tech Stack:** TypeScript, Express, `pg`, Postgres/Neon, OR-Tools (Python worker ou binding), Vitest/Node test, HTML wires em `docs/product/`.

## Global Constraints

- Vertical-agnóstico: zero `tancagem` no contrato; kind = `capacidade`; moeda/UoM/KPI aliases via `tenant_settings` / `tenants.config`.
- Shell UX **v0.3.1 green e congelado** — mudanças só cirúrgicas por buraco de contrato.
- Wizard visual deve espelhar 0.3.1 (não herdar v0.2 legado).
- Sem write-back ERP na V0 (export/plano aprovado).
- W0/W0.1 já feitos — não reabrir foundation sem ticket.
- 1 dev (Devi) até W1 estabilizar; 2º só se paralelo A4 vs UI for real.
- Após cada task: testes verdes + `harness/scripts/w0-grep-gate.sh` (e gates futuros) + pedir próxima ao PO.

## File map (alto nível)

| Área | Paths |
|------|--------|
| Migrations | `db/migrations/0007_*.sql` … |
| Domain/API | `src/domain/`, `src/http/app.ts`, `src/http/ui.ts` |
| A4 worker | `src/a4/` (novo) |
| Contracts | `contracts/*.schema.json` |
| Wires | `docs/product/*`, espelho em `/workspace/docs/superpowers/specs/` |
| Spec | `docs/product/2026-10-29-ibp-agentic-domain-rewire-design.md` |

---

### Task 1: Wizard UX v0.2.1 (agnóstico) — Didi

**Files:**
- Modify: `docs/product/2026-10-30-ibp-agentic-ux-wire-happy-path-v0.2.html` → publicar `...-v0.2.1.html` e espelho em `/workspace/docs/superpowers/specs/`
- Sync: shell link “Novo cenário” aponta para v0.2.1

**DoD:**
- [ ] Remover `tancagem` do mock (só `capacidade`); normalizar legado se houver
- [ ] Remover R$/OTIF/DSI hardwired — usar aliases do tenant config (mesmo contrato do shell)
- [ ] Copy Família C / labels genéricos
- [ ] Severity `info|warn|block` consistente
- [ ] Postar no Squad + marcar Qualidade

---

### Task 2: Docs sync (baixa) — PO / Deivid

**Files:**
- Modify: put spec INDEX / `docs/harness/*` / `INDEX.md` — tirar “cenário bloqueado” e `tancagem`

- [ ] Grep `tancagem` e “bloqueado até PO” no repo; corrigir
- [ ] Commit docs

---

### Task 3: W1a — `premise_cards` → `stable_id` — Devi

**Files:**
- Create: `db/migrations/0007_premise_cards_stable_id.sql`
- Modify: `src/domain/entities.ts`, API premise cards, `test/integration/api.test.ts`

**Interfaces:**
- Produces: `premise_cards.node_stable_id` FK → `nodes(stable_id)` (ou equivalente documentado); Gap exige node ref estável

- [ ] Migration + backfill
- [ ] Testes falham sem FK correta; depois passam
- [ ] Gate grep sem `nodes(id)` residual em premise_cards
- [ ] Pedir Task 4 ao PO (auto: seguir fila)

---

### Task 4: W1b — Prontidão A4 no backend (join nó+capacity) — Devi

**Files:**
- Create: `src/domain/a4Readiness.ts`
- Modify: `src/http/app.ts` (endpoint `GET /tenants/:id/a4-readiness`) — **feito como `GET /api/a4-readiness`** (tenant pelo header + RLS; ver README)
- Test: `test/integration/api.test.ts` — **feito em** `test/integration/a4-readiness.test.ts` + `test/unit/a4Readiness.test.ts`
- Migration: `db/migrations/0008_tenant_supply_external.sql` (flag supply externo)

**DoD (espelha checklist wire):**
- política WC (ou Estoque+Serviço) publicada
- ≥1 nó publicado com **capacity current** (`node_capacity`, não campo fantasma no nó)
- ≥1 rota publicada
- contrato se supply externo no escopo

- [x] Testes empty tenant vs sample seed
- [x] Resposta tipada ok/falta/n/a por item
- [x] Pedir Task 5

---

### Task 5: W1c — A4 run mínimo (OR-Tools) — Devi (+ Deivid review)

**Files:**
- Create: `src/a4/model.ts`, `src/a4/solve.ts`, `src/a4/explain.ts`
- Create: `contracts` usage for `A4RunSummary` + `A4Reason` (`kind` ∈ capacidade|janela|contrato|custo|outro)
- Migration: `a4_runs` table se ainda não existir
- Test: unit com fixture rede pequena (≤50 nós/SKUs)

**DoD:**
- [x] Input = scenario snapshot + policies + network + capacities + routes + contracts
- [x] Output = plan + `reasons[]` + `countsByKind` + `scenarioVersion`
- [x] Always-on top 3 razões; drill refs node/sku/route/period
- [x] Sem LLM no A4
- [x] Pedir Task 6

---

### Task 6: W2 — Wizard API (ditado → cartões) — Devi

**Files:**
- `src/agents/salesIntent.ts` (LLM barato, cache)
- Endpoints premise generate/edit/version
- Test com LLM mockado

**DoD:** cartões tipados NovaFilial|CurvaDemanda|Investimento|Gap; Gap com `node_stable_id` obrigatório
- [x] Cartões tipados (contrato `premise-card.schema.json`); Gap exige `links.nodeId` = stable_id corrente (`invalid_reference`)
- [x] Endpoints: create scenario (unlock 403/409) · list/get · cards aninhados · ditado · PATCH edit (version + audit)
- [x] LLM mockado nos testes (sem rede); 502 `ditado_unavailable`
- [x] Gate W2 · 0011 grant · docs
- Drift de arquivos: LLM em `src/wizard/ditado.ts` (não `src/agents/salesIntent.ts`); contrato = `docs/architecture/W2-WIZARD-API-CONTRACT.md`. Entregue 2026-10-30 01:44.
- [x] Pedir Task 7

---

### Task 7: W2b — Orchestrator stub A7 + decision event — Devi

- [x] State machine mínima; `decision-event.schema.json` approve|escalate + why (`src/a7/decision.ts`; ajv em runtime)
- [x] Audit trail persistido (`decision_events` append-only + `audit_log`)
- [x] Migration 0012 (grant SELECT/INSERT, FORCE RLS, FKs compostas cenário/run, CHECK actor_role) — dump antes, fresh DB + idempotente
- [x] `POST/GET /api/decision-events` (tenant header + RLS); why obrigatório, ≥20 c/ warn/block/partial; approve exige run done não stale
- [x] Testes (approve, escalate, why, stale, transições, RLS) + gate regra 5 (A7 sem LLM/prosa) + README/INDEX
- [ ] Review Deivid (0012 + drift `admin`→`domain_owner`, why opcional vs contrato) · Qualidade · PO
- [x] Pedir Task 8

---

### Task 8: W3 — Pulse/Caixa + Visões API — Devi

- [x] KPIs a partir de dados reais/seed; empty tenant sem inventar número (`value: null` + `nullReason`; `wc` = `not_computed_v0`)
- [x] CTAs por lente (já no wire) — `action{kind, enabled, disabledReason}` em `/api/visoes/:lens`
- [x] `GET /api/pulse/summary`, `/api/pulse/exceptions`, `/api/alcada/queue` (ajv), `/api/visoes/:lens` — zero migration, zero grant, GET only
- [x] DecisionEvent v0.2 (`impactMi/alcadaMi/escalateTo`) persistido no `audit_log.payload` via `POST /api/decision-events`; regras de alçada Finance
- [x] Testes (73/73) + gate regra 6 (violação plantada pega) + curl evidence `backups/w3-task8-curl-evidence.txt` + README/INDEX
- [ ] Review Deivid (persistência v0.2 no payload vs colunas; `alcadaMi=0` em misconfigured) · Qualidade · PO

---

### W3b (brief "Task 9"): Cadastro write API — pack + alçada em tenant_settings — Devi

- [x] Migration 0013 aditiva (dump antes `backups/ibp_v0-pre-0013-20261030-0224.dump`), idempotente, zero grant
- [x] 5 packs (`packs/*/profile.json`) + `GET /api/cadastro/packs`, `POST /api/cadastro/pack`, `PUT /api/cadastro/alcada`, `GET/PUT /api/tenant-settings` estendidos
- [x] Modos alçada `out_of_pack|no_policy (fail-closed)|misconfigured|active`; kinds de `tenant_settings.policy_kinds` (legado `{}` ≡ generic)
- [x] Regra 5 nos POST/PATCH/DELETE genéricos de `policies` (409 `alcada_exists` / `alcada_required_in_pack`)
- [x] Testes (87/87) + gate regra 7 (plantadas pegas; regra 6 verde) + curl evidence `backups/w3b-task9-curl-evidence.txt` + README/INDEX
- [x] PO residual (02:38): `npm run seed:demo-alcada` → sample-demo `industry_pack=generic` + POL alçada `limitMi=2` (active, v1); tenants vazios seguem `no_policy`; teste `integration/seed-demo-alcada.test.ts`; evidência `backups/seed-demo-alcada-evidence.txt` (dump `backups/ibp_v0-pre-seed-demo-alcada-20261030-0240.dump`); 89/89
- [ ] Review Deivid (respostas estendidas, `alcada_ambiguous`, md5 `alcada-queue-item` divergente do registrado) · Qualidade

---

### W4 (brief "Task 10"): Execution pulse write — Devi

- [x] Contrato `docs/architecture/W4-EXECUTION-PULSE-WRITE-CONTRACT.md` aprovado (PO: bucket dia, all-or-nothing, 15% fixo)
- [x] Migration 0014 aditiva (dump antes `backups/ibp_v0-pre-0014-20261030-0244.dump`), FORCE RLS, FKs compostas, GRANT SELECT/INSERT + UPDATE(status) + trigger void-only; idempotente
- [x] `POST /api/execution/movements`, `POST …:batch` (≤100, all-or-nothing), `POST …/:id/void` (why), `GET …/movements` (default posted)
- [x] Pulse: `GET /api/pulse/exceptions` fonte `execution` (warn >15%, block planned>0 actual=0); `GET /api/pulse/summary` `pending.executionExceptions` + `execution.adherence`
- [x] `contracts/execution-movement.schema.json` (ajv runtime + testes); enums PremiseCard/DecisionEvent intocados
- [x] Testes 99/99 (+4 unit, +6 integração) + gate regra 8 (plantadas pegas) + curl evidence `backups/w4-task10-curl-evidence.txt` (sample-demo warn/block) + README/INDEX
- [ ] Review Deivid (UPDATE só coluna status, aderência 7 dias, why só no audit) · Qualidade (Pulse UI com fonte execution)

---

### Task 9: Qualidade contínua

- Após Task 1: retest wizard v0.2.1
- Após Task 4–5: regressão readiness + A4
- Achados com severidade no Squad; sem idle — pedir próximo caso ao PO

---

### Task 10: W4–W6 (backlog ordenado)

- ~~W4 Execution pulse write path~~ → entregue (seção W4 acima)
- W5 Journey D3 productization
- W6 Write-back + harden

Detalhar em plano filho quando W2 fechar.

## Fila imediata (agora)

| Quem | Próxima atividade |
|------|-------------------|
| **Didi** | Task 1 — wizard v0.2.1 |
| **Devi** | Task 3 — premise_cards stable_id (já; não esperar idle) |
| **Deivid** | Review desenho A4 (Task 5) + Task 2 docs grep |
| **Qualidade** | Retest wizard assim que Didi postar 0.2.1; senão seguir checklist A4 no app W0.1 |
| **PO** | Manter fila; greener cada DoD; plano filho W2 quando Task 5 done |

