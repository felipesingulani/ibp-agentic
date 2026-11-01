# INDEX — ibp-agentic (Domain Rewire / IBP Agentic)

> Mapa canônico do repositório. **Todo agent deve ler este arquivo no início de cada sessão** e **atualizá-lo** sempre que criar, mover ou remover pastas/arquivos relevantes (com 1 linha de descrição).

**Wave atual:** W0+W0.1 fechados · **W1 em andamento** — slice 1 (0007), W1b (prontidão A4, 0008) e **W1c** (run A4 CBC: `a4_runs` 0009 + `POST/GET /api/a4-runs`) entregues; `confirmed_at` (0010) entregue · **W2 Task 6** (Wizard API, 0011) e **Task 7 / W2b** (A7 stub + `decision_events`, 0012) entregues; **Task 8 / W3** (Pulse + Visões + fila de alçada, GET only, sem migration) e **Task 9 / W3b** (Cadastro write API: packs + alçada em `tenant_settings`, 0013) entregues; **Task 10 / W4** (execution pulse write: `execution_movements` 0014 + `/api/execution/movements*` + Pulse fonte `execution`) entregue; **Task 11 / W5** (Journey D3: `journey_runs` 0015 + `/api/journey/runs*` + conviction pack JSON/MD + land thin) entregue; **Task 12 / W6** (harden land papel+link 0017, warn kind, 409 `steps_out_of_order`) entregue; **Task 13 / W7** (export do plano aprovado: `GET /api/plans/approved/export?format=json|csv`, GET only, sem migration) entregue. Shell **v0.3.9** no ar (Vercel) · wire→live P1 em curso.

**Última atualização:** 2026-11-01 (pin UI W6 live `41d290c9…` em `harness/pins.json`) · antes: 2026-11-01 (harness V0: `docs/architecture/HARNESS.md`, `scripts/harness/{lib,pins,smoke,report}.ts`, `harness/pins.json`, `.github/workflows/ci.yml`, scripts `harness:l0|pins|smoke|report`; L0–L3, L4 fora) · antes: 2026-10-31 18:35 (Devi — T-A7-LEVE: `src/a7/orchestrate|roster|system-decision.ts`, `http/a7.ts`, `contracts/a7-orchestration.schema.json`, gate regra 12, testes + evidence; sem migration/UI) · antes: 2026-10-31 (Devi — T-A1-ENG: `wizard/curva.ts`, a1-curva tests, gate rule 11, `seed:a1-fixture`, evidence) · antes: 2026-10-30 12:40 (Deivid — DATA-MODEL sync 0012–0017/W4–W7 + data-model.html + WIRE-LIVE-P1) · antes: 2026-10-30 03:50 (Devi — Task 13 / W7: `src/plans/`, `http/plans.ts`, `contracts/plan-export.schema.json`, export JSON/CSV só do plano aprovado (409 `no_approved_plan`), papéis admin|domain_owner|finance, audit só no 200, gate regra 10) · antes: 2026-10-30 03:35 (Devi — Task 12 / W6: 0017 `journey_land_link()` definer, land 403 `forbidden_role` + link 400 uniforme, 409 `steps_out_of_order`, warnings `policy_kind_unknown` em policies/readiness) · antes: 2026-10-30 03:20 (Devi — med W5 `0016` land fn seta `app.tenant_id` do tenant novo · F-1 `paramsFrom` ← `tenant_settings.policy_kinds`) · antes: 2026-10-30 03:05 (Devi — Task 11 / W5: 0015 `journey_runs` + `journey_land_tenant()` definer, `src/journey/`, `http/journey.ts`, gate regra 9) · antes: 2026-10-30 02:55 (Devi — thin fix KPI labels: `Kpi.label` string não nula, defaults pt-BR + allowlist V0 + aliases, `{cap}` do pack/tenant; sem migration) · antes: 2026-10-30 02:55 (Devi — Task 10 / W4: 0014 `execution_movements` FORCE RLS + UPDATE só `status` + trigger void-only, `src/execution/`, `http/execution.ts`, Pulse fonte `execution` + aderência, gate regra 8) · antes: 02:42 (Devi — PO residual W3b: `seed:demo-alcada` → sample-demo alçada 2 mi) · antes: 02:40 (Devi — Task 9 / W3b: 0013, `packs/`, `src/cadastro/`, `http/cadastro.ts`, modos out_of_pack/no_policy fail-closed, gate regra 7) · antes: 02:20 (Devi — Task 8 / W3: `src/w3/`, `http/pulse|visoes|alcada.ts`, DecisionEvent v0.2 persistido no audit payload, gate regra 6) · antes: 01:52 Devi Task 7 / W2b; Deivid 02:04 bump `decision-event.schema.json` v0.2

---

## Raiz

| Path | Descrição |
|------|-----------|
| `AGENTS.md` | Lei do repo: ALLOW/DENY W0, ordem de verdade, obrigação de ler/atualizar este INDEX |
| `INDEX.md` | Este mapa — manter sincronizado com a árvore real |
| `README.md` | Como subir local (compose, migrate, seed, API) |
| `package.json` | Scripts npm (`db:up`, `migrate`, `seed`, `dev`, `test`, `gate`, `harness:l0`, `harness:pins`, `harness:smoke`, `harness:report`) |
| `tsconfig.json` | TypeScript strict / NodeNext (`src`, `test`, `scripts`) |
| `.github/workflows/ci.yml` | CI L0 em push/PR: typecheck, gate, INDEX, pins md5, `npm test` (Postgres 16) |
| `docker-compose.yml` | Postgres 16 local; init com `contracts/v0-postgres-cadastro.sql` |
| `.env.example` | Variáveis obrigatórias (`DATABASE_URL`, `MIGRATION_DATABASE_URL`, …) |
| `.gitignore` | node_modules, .env, dist, logs |

---

## `contracts/` — contratos de dados (fonte da verdade técnica)

| Path | Descrição |
|------|-----------|
| `v0-postgres-cadastro.sql` | Schema Postgres §5 + runtime tables + RLS skeleton (baseline migrate 0001) |
| `premise-card.schema.json` | Cartão de premissa tipado (Gap exige `nodeId` = stable_id de nó corrente) |
| `a4-reason.schema.json` | Razão A4 (`kind`: janela\|capacidade\|contrato\|custo\|outro; `severity` info\|warn\|block) |
| `a4-run-summary.schema.json` | Always-on A4 + `scenarioVersion` + `countsByKind` |
| `decision-event.schema.json` | Aprovar/escalar + `why` obrigatório — usado em runtime (ajv) por `POST /api/decision-events` (Task 7) |
| `a7-orchestration.schema.json` | T-A7-LEVE: resposta `a7.orch.v1` de `POST /api/a7/evaluate` (veredito, provocations A1–A3/A5/A6, pacote, basis, committedEventId) — ajv em runtime |
| `alcada-queue-item.schema.json` | W3: item da fila de alçada Finance — projeção read-only (scenario+Investimento+POL alçada+DecisionEvents); validado em runtime por `GET /api/alcada/queue` (Task 8) |
| `plan-export.schema.json` | W7: envelope do export do plano aprovado (`exportVersion` w7.v0, `planRef` basis=approved, run, settings, `plan` cru sem `reasonCandidates`); validado em runtime (ajv) no JSON de `GET /api/plans/approved/export` (Task 13) |
| `execution-movement.schema.json` | W4: ExecutionMovement do wire (`/api/execution/movements*`); validado em runtime (ajv) na saída da API (Task 10) |
| `SECURITY-GUIDELINES.md` | Tenancy, auth, LLM (futuro), API, código |
| `README.md` | Índice dos contratos |

---

## `db/` — migrations aditivas

| Path | Descrição |
|------|-----------|
| `migrations/0002_rls_all_tables.sql` | Completa RLS em todas as tabelas com `tenant_id` |
| `migrations/0003_tenant_settings.sql` | Settings agnósticos (currency, uom, node_types, kpi_labels) |
| `migrations/0004_app_role_grants.sql` | Grants da role app (`ibp_app`, NOSUPERUSER NOBYPASSRLS) |
| `migrations/0005_relax_vertical_checks.sql` | W0.1: remove CHECKs de vertical em `nodes.node_type` / `policies.kind` (só "não vazio"); validação na API via `tenant_settings` |
| `migrations/0006_stable_ids.sql` | W0.1: `stable_id` em toda entidade versionada + `nodes_identity`/`skus_identity`; FKs compostas `(tenant_id, stable_id)` de capacity/routes/sales_history; backfill/rewrite dos dados existentes |
| `migrations/0007_premise_cards_stable_node.sql` | W1 s1: `premise_cards.node_id` → `nodes_identity` (FK composta + backfill); `scenario_id` FK composta por tenant; FORCE RLS; grant app só em `premise_cards` |
| `migrations/0008_tenant_supply_external.sql` | W1b: `tenant_settings.supply_external_in_scope` (bool, default false) — exige contrato na prontidão A4 |
| `migrations/0011_wizard_scenarios_grant.sql` | W2: grant SELECT/INSERT/UPDATE em `scenarios` p/ `ibp_app` (sem DELETE) |
| `migrations/0013_tenant_industry_profile.sql` | W3b: `tenant_settings` + `industry_pack`/`entity_labels`/`policy_kinds`/`agent_roster` (aditivo, zero grant) |
| `migrations/0014_execution_pulse.sql` | W4: `execution_movements` (FKs compostas run/nó/SKU, FORCE RLS, GRANT SELECT/INSERT + UPDATE(status); trigger só posted→void) |
| `migrations/0015_journey_d3.sql` | W5: `journey_runs` (lab tenant, FORCE RLS, GRANT SELECT/INSERT/UPDATE, sem DELETE) + `journey_land_tenant()` SECURITY DEFINER (única porta p/ criar tenant thin no land; EXECUTE só `ibp_app`) |
| `migrations/0016_journey_land_set_tenant.sql` | W5 med (review Deivid): `CREATE OR REPLACE journey_land_tenant()` — `app.tenant_id` ← tenant novo antes dos INSERTs em `tenants/users` (FORCE RLS sem depender de BYPASSRLS) e volta ao lab; assinatura/grants/API inalterados |
| `migrations/0017_journey_land_link.sql` | W6: `journey_land_link(run, target, actor)` SECURITY DEFINER (EXECUTE só `ibp_app`) — link válido ⇔ mesmo e-mail do ator é admin no alvo; lê alvo via `app.tenant_id` e restaura o lab |
| `migrations/0012_decision_events.sql` | W2b: grant SELECT/INSERT em `decision_events` (append-only), FORCE RLS, FKs compostas cenário/run (run do mesmo cenário), CHECK `actor_role` |
| `migrations/0010_tenant_confirmed_at.sql` | `tenant_settings.confirmed_at timestamptz NULL` — unlock Novo cenário = confirmado ∧ prontidão ≠ block |
| `migrations/0009_a4_runs.sql` | W1c: `a4_runs` status + `queued`, `error`, FK composta (tenant, cenário), `run_code` único/tenant, FORCE RLS (a4_runs, scenarios), grants app (a4_runs SELECT/INSERT/UPDATE, scenarios SELECT) |

Baseline `0001` = arquivo em `contracts/v0-postgres-cadastro.sql` (aplicado via compose init ou `npm run migrate`).

---

## `src/` — aplicação (W0/W0.1 + W1 slice 1)

| Path | Descrição |
|------|-----------|
| `config/env.ts` | Leitura tipada de env |
| `db/pool.ts` | Pool pg + `withTenant` (`set_config app.tenant_id`) |
| `db/migrate.ts` | Runner: 0001 contrato + `db/migrations/*` (serializado por `pg_advisory_lock`) |
| `db/seed.ts` | Seed tenant demo vazio (agnóstico) |
| `db/seed-demo-alcada.ts` | `npm run seed:demo-alcada [-- slug]` (default sample-demo): alçada default do pack (2 mi) via `upsertAlcada`; idempotente; não toca POL existente nem out_of_pack |
| `../scripts/seed-a1-fixture.ts` | `npm run seed:a1-fixture -- qa-a1-<data>` (T-A1-ENG): only slug `qa-a1-*`, refuses E0; owner = tenant/user/settings, rest via API (minimal E1, anchors ANC12/05/00 with 12/5/0 months, SKU, target, scenario); idempotent; local only |
| `domain/entities.ts` | Registry Zod das entidades de cadastro + paths REST + aliases API↔coluna (`capacity_per_period`, `cost_per_unit`) |
| `a4/model.ts` | W1c: snapshot + LP piloto (fluxo rota×SKU, capacidade `node_capacity`, serviço/lead time/contrato soft) + limites piloto · F-1: `paramsFrom` filtra policies por `inKindGroup(snapshot.policyKinds)` (vocabulário do tenant; legado se `{}`) |
| `a4/solve.ts` | W1c: processo filho Python CBC (JSON stdin/stdout, timeout SIGKILL; `A4_PYTHON`) · T-A4-SOLVER-WORKER: dual-path — `A4_SOLVER_URL` set → HTTP `POST /v1/solve` no worker (header `x-a4-solver-secret`=`A4_SOLVER_SECRET`, timeout ≤25s, falha → `solver_unavailable`) + preflight `/health` 2s; unset → spawn local |
| `a4/explain.ts` | W1c: plano + reasons (enum do contrato) top 3 + `countsByKind` |
| `a4/run.ts` | W1c: loader do snapshot sob RLS (F-1: + `tenant_settings.policy_kinds` → `policyKinds`) + ciclo queued→running→feasible/partial/failed (fila em processo) |
| `domain/a4Readiness.ts` | W1b: checklist prontidão A4 (ok/falta/n/a, pct = ok ÷ exigidos) — função pura + loader SQL sob RLS · W6: warning `policy_kind_unknown` |
| `http/app.ts` | Express app: auth stub, CRUD genérico, audit, settings, UI router · W6: `warnings` (policy_kind_unknown) em POST/PATCH `/api/policies` · W7: monta `/api/plans` |
| `http/common.ts` | Helpers HTTP compartilhados: Ctx, audit, `why`, `assertCurrentRefs` (regra única de referência por stable_id corrente) |
| `a7/decision.ts` | W2b: A7 stub determinístico — máquina de estados pending→escalated→approved, pré-condições (run done/não stale), regra do why (≥20 c/ warn/block/partial), papel → `actor.role` |
| `a7/contract.ts` | W2b: valida DecisionEvent contra `contracts/decision-event.schema.json` (ajv em runtime) · T-A7-LEVE: `assertA7Orchestration` (`contracts/a7-orchestration.schema.json`) |
| `http/decision-events.ts` | W2b: `POST/GET /api/decision-events[/:id]` (tenant+RLS, advisory lock por cenário, audit_log) · Task 8: alçada Finance + v0.2 `impactMi/alcadaMi/escalateTo` (audit payload) |
| `a7/event-out.ts` | Task 8: `DECISION_SELECT` (LATERAL no `audit_log.payload`) + `decisionOut` v0.2 |
| `a7/premise-change.ts` | Task 8: `lastPremiseChangeAt` (staleness por premissa; compartilhado A7/W3) |
| `a7/orchestrate.ts` | T-A7-LEVE: orchestrator leve puro — veredito `auto_policy\|escalate_human\|await_inputs`, provocations stub (A1–A3/A5/A6; A4 nunca), pacote (premissas/violações/opções), `whyFor` |
| `a7/roster.ts` | T-A7-LEVE: `assertA7Enabled` (pack + `tenant_settings.agent_roster`; 409 `a7_disabled`) |
| `a7/system-decision.ts` | T-A7-LEVE: decisão `actor.role=system` (`SYSTEM_ACTOR`) sobre `evaluateDecision` — 409 closed/already_escalated, 403 defensivo `alcada_finance_required` |
| `http/a7.ts` | T-A7-LEVE: `POST /api/a7/evaluate` (`a7.orch.v1`; tenant+RLS; `commit` → DecisionEvent system + pacote no `audit_log.payload.a7`; advisory lock) |
| `w3/plan-ref.ts` | Task 8: `planRef` approved > latest_run > none |
| `w3/kpi.ts` | Task 8: KPIs svc/cost/viol/wc/util com `source` e `nullReason` (sem número inventado); labels nunca null (`labelOf`: tenant › pack › `KPI_LABEL_DEFAULTS`, allowlist V0) |
| `w3/exceptions.ts` | Task 8: exceções (a4_run, readiness, premise_gap, alcada; W4: execution, dedupe c/ dia) + dedupe/ordem |
| `w3/alcada.ts` | Task 8: POL alçada (`body.limitMi`; kinds do tenant desde W3b) → modos active/misconfigured/no_policy/out_of_pack (W3b), impacto Investimento, fila + status |
| `w3/snapshot.ts` | Task 8: snapshot único SELECT-only → Pulse summary + 3 lentes (números compartilhados) + nextStep; W4: `execution{movements, adherence}` + `pending.executionExceptions` |
| `w3/contract.ts` | Task 8: ajv runtime de `alcada-queue-item.schema.json` |
| `http/pulse.ts` | Task 8: `GET /api/pulse/summary`, `GET /api/pulse/exceptions` |
| `http/visoes.ts` | Task 8: `GET /api/visoes/:lens` (400 `invalid_lens`) |
| `http/alcada.ts` | Task 8: `GET /api/alcada/queue` (W3b: notice por modo + `nextStep publish_alcada` + `needsPolicy`) |
| `domain/policy-kinds.ts` | W3b: grupos de kind (working_capital/inventory/service/alcada), legado `{}`, `effectivePolicyKinds`, `normalizeKind` · W6: `isKnownKind`, `policyKindWarnings` |
| `cadastro/packs.ts` | W3b: loader + zod dos `packs/*/profile.json`, `listPacks`/`getPack` |
| `cadastro/settings.ts` | W3b: lock por tenant, validação labels/roster/policy_kinds, view do GET, `writePack` (Regra 1) |
| `cadastro/alcada-write.ts` | W3b: `upsertAlcada`, `applyPackAlcada` (Regra 2), switch p/ generic (Regra 3), hooks do CRUD genérico (Regra 5) |
| `http/cadastro.ts` | W3b: `GET /api/cadastro/packs`, `GET/PUT /api/tenant-settings`, `POST /api/cadastro/pack`, `PUT /api/cadastro/alcada` |
| `execution/pulse.ts` | W4: regras puras — buckets dia, exceções `execution` (warn >15% fixo, block planned>0 actual=0), aderência 7 dias |
| `execution/store.ts` | W4: zod do wire, lock por tenant, insert (âncora no run, refs correntes, uom default, audit), void, list, leitura p/ Pulse |
| `execution/contract.ts` | W4: ajv runtime de `execution-movement.schema.json` |
| `http/execution.ts` | W4: `POST /api/execution/movements`, `POST …/movements:batch` (≤100, all-or-nothing), `POST …/:id/void`, `GET …/movements` |
| `plans/contract.ts` | W7: `EXPORT_VERSION`, `EXPORT_ROLES` (admin\|domain_owner\|finance), `parseExportFormat` (400 `validation_failed {field:"format"}`), colunas/seções do CSV long, `assertPlanExport` (ajv) |
| `plans/export.ts` | W7: `loadApprovedExport` (via `resolvePlanRef`; ≠ approved → 409 `no_approved_plan {basis}`, nunca latest_run), `buildPlanExport` (plan cru − `reasonCandidates`), `toCsv` (RFC 4180, CRLF, linha `#` planRef, null → vazio), `exportFilename` |
| `journey/contract.ts` | W5: steps fixos (leverage/consensus/roles/conviction), zod do wire (create/step/land/list/download) · W6: `LAND_ROLES`, `stepOrderGap` |
| `journey/snapshot.ts` | W5: snapshot SELECT-only via `loadW3` — alavancas WC/serviço/expedite (+custo, aderência) com nullReason, consenso (DecisionEvents + latência escalate→approve), papéis (roster + gaps) |
| `journey/conviction.ts` | W5: conviction pack = templates pt-BR + números do snapshot → JSON+MD em `$JOURNEY_EXPORT_DIR` (default `var/journey/<tenant>/<code>-conviction.*`) |
| `journey/store.ts` | W5: create/list/get, snapshot, steps, conviction, land (link `landTenantId` \| cria thin via `journey_land_tenant()` + pack default + POL alçada) sob lock + audit · W6: link via `journey_land_link()` (400 uniforme), 409 `steps_out_of_order`, log warn de recusa |
| `http/plans.ts` | W7: `GET /api/plans/approved/export?format=json\|csv` — 401 → 403 `forbidden_role` → 400 → 409; 200 attachment (Content-Disposition, `Cache-Control: no-store`, CSV com BOM, sem ETag), audit `export` só no 200; nada em disco |
| `http/journey.ts` | W5: `/api/journey/runs` (+`/:id`, `/snapshot`, `/steps/:stepId/complete`, `/conviction` POST+GET download, `/land`) · W6: land 403 `forbidden_role` (admin\|domain_owner) |
| `http/a4-runs.ts` | W1c: `POST /api/a4-runs` (202, 409 `a4_not_ready`), `GET /api/a4-runs[/:id]` → `A4RunSummary` + plano · T-A4-SOLVER-WORKER: com `A4_SOLVER_URL`, preflight health → 503 `{error:{code:"solver_unavailable"}}` sem criar run |
| `http/premise-cards.ts` | `premise_cards` alinhado ao contrato W2 (`links.nodeId`, Gap → `invalid_reference`, PATCH `source=edit` + version + audit) |
| `http/scenarios.ts` | W2 Wizard API: criar cenário (unlock 403/409), listar/ler + cards, cards aninhados, ditado (502 `ditado_unavailable`); `mountWizard` |
| `wizard/cards.ts` | W2: validação única de PremiseCard (tipos, `fields` escalares, Gap → nó corrente), `insertCard`, `card_id` automático, projeção de contrato |
| `wizard/ditado.ts` | W2: **único ponto de LLM** — `DitadoLlm` injetável (mock nos testes), provedor HTTP via env, timeout, teto diário, cache sha256(tenant,texto), validação da saída |
| `wizard/curva.ts` | T-A1-ENG: CurvaDemanda v1 — pure `buildCurva` (hist 12m → 18 pts, 3 profiles, gaps `hist_none`/`hist_insufficient`/`anchor_missing`), zod v1, roster `a1_disabled`, dedupe `duplicate_curve`, `deriveCurva` (SELECT-only on `sales_history`) |
| `http/ui.ts` | UI HTML mínima read-only do cadastro (`/ui/...`) |
| `http/errors.ts` | `HttpError` + mapeamento Postgres/Zod → HTTP |
| `http/server.ts` | Entry: listen na `PORT` |

---

## `docs/` — produto, arquitetura, harness

| Path | Descrição |
|------|-----------|
| `product/2026-10-29-ibp-agentic-domain-rewire-design.md` | Put spec (domínio, A1–A7, §11 superfícies, waves) |
| `product/2026-10-30-ibp-agentic-ux-wire-happy-path-v0.2.html` | Wire do fluxo Novo cenário (wizard = W2; frozen, não editar) |
| `product/2026-10-30-ibp-agentic-ux-wire-shell-v0.3.html` | Wire shell: Cadastro · Pulse/Caixa · Visões · Cenários |
| `architecture/DOM-CADASTRO-WRITE-SEED-CHECKLIST.md` | T-DOM-CAD-PREP (Devi, 2026-10-31): inventário seed Cadastro + gaps E0 empty × E1 ready + papéis QA + passos idempotentes/reset + 3 cravos PO (docs only, sem impl) |
| `architecture/T-A1-ENG-EVIDENCE.md` | T-A1-ENG (2026-10-31): A1 CurvaDemanda v1 API-only evidence — QA M/H → test mapping, 161/161, gate rule 11, deviations for Deivid review; + `T-A1-ENG-test.log`, `T-A1-ENG-curl-proof.log` (local) |
| `architecture/HARNESS.md` | Contrato harness V0: L0 (typecheck+gate+INDEX+pins+test), L1 pins md5, L2 smoke GET S1–S8, L3 relatório QA + linha DoD SHA+md5; L4 (Playwright/Pact/Neon branch/LLM judge) fora |
| `architecture/SECURITY-GUIDELINES.md` | Cópia operacional das guidelines de segurança |
| `architecture/W1-A4-SKELETON.md` | Esqueleto W1 (A4) — ordem dos slices; slices 1–4 (stable_id, prontidão, `a4_runs`, solver) feitos |
| `architecture/W1C-OR-TOOLS-DESIGN.md` | Desenho W1c (A4 CBC mínimo) + notas de implementação |
| `architecture/T-A4-SOLVER-WORKER-EVIDENCE.md` · `T-A4-SOLVER-WORKER-TEST-LOG.txt` | Evidência eng T-A4-SOLVER-WORKER (worker HTTP + dual-path + preflight 503) + log `npm test`/gate/docker smoke |
| `architecture/W2-WIZARD-API-CONTRACT.md` | Contrato Task 6 (W2 wizard API: scenarios, ditado mock, unlock) |
| `architecture/W3-PULSE-VISOES-API-CONTRACT.md` | Contrato Task 8 (W3, rascunho Deivid): Pulse summary/exceptions, fila alçada, Visões por lente — read-only, sem KPI inventado |
| `architecture/W3B-CADASTRO-WRITE-API-CONTRACT.md` | Contrato Task 9 (W3b, rascunho Deivid · aguarda PO): pack de indústria + labels + `policy_kinds` + roster + limiar alçada em `tenant_settings` (0013 aditiva, zero grant); fail-open ⇔ pack sem alçada |
| `architecture/W4-EXECUTION-PULSE-WRITE-CONTRACT.md` | Contrato Task 10 (W4, aprovado Deivid + PO: bucket dia, all-or-nothing, 15% fixo · implementado 2026-10-30): execution_movements + POST/void + Pulse exceptions fonte `execution` |
| `architecture/W5-JOURNEY-D3-CONTRACT.md` | Contrato Task 11 (W5, Deivid + cravos PO 2026-10-30: cria-tenant / lab-tenant / GET conviction · implementado 2026-10-30): journey_runs + conviction pack → land |
| `architecture/W6-LAND-HARDEN-KIND-WARN-CONTRACT.md` | Contrato Task 12 (W6, aprovado Deivid + PO · green 2026-10-30): harden land (papel + link sem oráculo) + warn kind + ordem steps; ERP/scope/abandon/export fora |
| `architecture/W7-PLAN-EXPORT-CONTRACT.md` | Contrato Task 13 (W7, aprovado Deivid + PO 2026-10-30: só approved / JSON+CSV cru / admin+domain_owner+finance / sem rede-ERP): `GET /api/plans/approved/export?format=json\|csv` attachment, 409 `no_approved_plan`, sem migration, gate regra 10; CTA UI = thin Didi |
| `architecture/DEPLOY-NEON-CHECKLIST.md` | Checklist deploy prep Neon + Vercel (Deivid, 2026-10-30 · prep, nada deployado): claim 72h/token, migrate 0001→0017 (owner direto), verificação NOBYPASSRLS/grants/definer 0016–0017, envs build×runtime, smoke Pulse/land/export, bloqueios Felipe, residual HEAD 405 |
| `architecture/DATA-MODEL.md` | Modelo de dados em linguagem simples (tenancy/RLS, versionamento `stable_id`, settings, runtime, FKs, unlock, fora do V0) + ER mermaid — **sync até 0017 + contratos W4–W7** (Deivid, 2026-10-30 12:40 UTC-3): `execution_movements`, `journey_runs`, definer `journey_land_tenant`/`journey_land_link`, colunas 0013, export W7 sem migration, papéis por operação, §9 gaps backlog. Companion navegável `architecture/data-model.html` sincronizado junto |
| `harness/README.md` | Ponte para o contrato V0 em `architecture/HARNESS.md` (L0–L3) |
| `harness/W0-SCOPE.md` | Lock de escopo W0 |
| `harness/PR-CHECKLIST.md` | Checklist de PR: L0/pins do harness V0 + itens históricos da foundation |
| `harness/GUARDRAILS.md` | Stop rules; L0 no CI; gate ativo = `w2-grep-gate.sh` |

---

## `harness/` — automação de guardrail

| Path | Descrição |
|------|-----------|
| `pins.json` | L1: md5 golden da UI `public/index.html` (`41d290c9…`, W6 live), schemas em `contracts/`, SQL baseline e contrato do worker A4 |
| `scripts/w0-grep-gate.sh` | Gate W0 (histórico, `npm run gate:w0`): LLM/solver/rotas de cenário |
| `scripts/w1-grep-gate.sh` | Gate W1c (histórico): CBC ok; LLM, Gurobi/CPLEX, `/scenarios`, `/ditado`, `/optimize` proibidos |
| `scripts/w2-grep-gate.sh` | Gate atual (`npm run gate`): rotas do wizard só em arquivos do wizard; marcadores de chamada LLM só em `src/wizard/`; `fetch(` no backend só em `src/wizard/`; vendor LLM/Gurobi/CPLEX/optimize negados · regra 5 (Task 7): `src/a7/` + `http/decision-events.ts` sem LLM/prompt/narrativa/fetch/ditado · regra 6 (Task 8): `src/w3/` + `http/pulse|visoes|alcada*` sem LLM/narrativa/fetch e sem escrita (SQL INSERT/UPDATE/DELETE, `.post/.put/.patch/.delete(`) · regra 7 (Task 9/W3b): `src/cadastro/` + `http/cadastro*` + `packs/` sem LLM/prompt/narrativa/fetch/ditado (gate roda também em `packs/`) · regra 8 (Task 10/W4): `src/execution/` + `http/execution*` sem LLM/prompt/narrativa/fetch/ditado e sem DELETE · regra 9 (Task 11/W5): `src/journey/` + `http/journey*` sem LLM/prompt/narrativa/fetch/ditado, sem cliente de rede (node:http(s)/axios/undici) e sem DELETE · regra 10 (Task 13/W7): `src/plans/` + `http/plans*` sem LLM/prompt/narrativa/fetch/ditado/cliente de rede e sem escrita (SQL INSERT/UPDATE/DELETE, `.post/.put/.patch/.delete(`) |
| `scripts/w2-grep-gate.sh` · rule 11 | T-A1-ENG: `src/wizard/` without INSERT/UPDATE/DELETE/TRUNCATE on `sales_history` |
| `scripts/w2-grep-gate.sh` · rule 13 | T-A4-SOLVER-WORKER: `fetch(` liberado só em `src/a4/solve.ts` (worker A4 + preflight); resto do backend segue regra 4 |
| `scripts/w2-grep-gate.sh` · rule 12 | T-A7-LEVE: regra 5 cobre `http/a7*.ts`; path A7 (`src/a7/` + `http/a7*`) sem `a4-runs`/INSERT|UPDATE `a4_runs`/import do solver/`executeRun`, sem Gurobi/cplex/optimize, sem cliente de rede/ERP |

## `scripts/harness/` — harness V0 (L0–L3)

| Path | Descrição |
|------|-----------|
| `lib.ts` | md5 de arquivo, carga de `harness/pins.json`, `git rev-parse HEAD` |
| `pins.ts` | L1: confere os md5 golden (`npm run harness:pins`) |
| `smoke.ts` | L2: smoke só GET S1–S8 — health, 401, tenant seed (me/pulse/a4-readiness), md5 da UI, `/health` do worker (`npm run harness:smoke`) |
| `report.ts` | L3: checklists `QA-ACCEPTANCE*.md` + SHA + md5 do smoke; linha `DOD <sha> <md5>` (`npm run harness:report`) |

---

## `packs/` — packs de indústria (W3b)

| Path | Descrição |
|------|-----------|
| `packs/README.md` | Formato do `profile.json` e regra alçada ⇔ `policy_kinds.alcada` |
| `packs/{generic,oilgas,cpg,retail,generic_no_alcada}/profile.json` | 5 seeds: labels, uom, node_types, kpi_labels, policy_kinds, agents (A4 cbc, A7 state_machine_only); `generic_no_alcada` = único sem alçada (out_of_pack) |

## `solver/` — A4 (W1c)

| Path | Descrição |
|------|-----------|
| `cbc_solve.py` | LP JSON (stdin) → CBC open-source → status/objetivo/valores (stdout). Venv em `solver/.venv` (gitignored) · núcleo `solve_model(m)` reusado pelo worker |
| `worker.py` | T-A4-SOLVER-WORKER: worker HTTP stdlib — `GET /health` · `POST /v1/solve` (= stdout `cbc_solve.py`; 401 secret · 400 body · 500 curto); fail-closed sem `A4_SOLVER_SECRET`; porta `$PORT` |
| `Dockerfile` · `.dockerignore` | T-A4-SOLVER-WORKER: image mínima do worker (python:3.11-slim + `ortools==9.15.6755`, user nobody) — separada do Dockerfile do app |

---

## `test/`

| Path | Descrição |
|------|-----------|
| `unit/health.test.ts` | Smoke unitário |
| `unit/a4Readiness.test.ts` | W1b: `computeReadiness` (vazio, kinds de política, flag supply externo, rótulo WC do tenant) |
| `unit/a4-solver.test.ts` | W1c: CBC real em fixture (falta de capacidade, viável, janela/contrato/Gap legado), mapeamento de kind, limites piloto, ajv · F-1: alias custom (retail `fill_rate`), kind fora do vocabulário ignorado, `{}` ≡ legado |
| `integration/a4-runs.test.ts` | W1c E2E: 409 readiness block, 400 cenário alheio, run happy partial (capacidade), feasible, RLS B 404, ajv · F-1: `loadSnapshot` lê `policy_kinds` sob RLS (custom vs legado) |
| `support/a4-worker.ts` | T-A4-SOLVER-WORKER: sobe `solver/worker.py` real em porta livre p/ testes (url/log/stop) |
| `unit/a4-solver-remote.test.ts` | T-A4-SOLVER-WORKER: `solve.ts` dual-path com HTTP mock (200/401/5xx/timeout/JSON inválido/rede → `solver_unavailable`), preflight health, unset → spawn local |
| `unit/a4-solver-worker.test.ts` | T-A4-SOLVER-WORKER: worker real — health, solve ≡ `cbc_solve.py`, infeasible, 401/400/404, secret fora do log, fail-closed, Node HTTP ≡ spawn |
| `integration/a4-solver-worker.test.ts` | T-A4-SOLVER-WORKER E2E: worker down → 503 sem INSERT; worker real → run partial via HTTP; secret errado → failed `solver_unavailable`; unset → W1c |
| `support/schemas.ts` | Validadores ajv dos contratos (`a4-*`, `premise-card.schema.json`, `decision-event.schema.json`, `alcada-queue-item.schema.json`, `execution-movement.schema.json`) |
| `unit/kpi-labels.test.ts` | Labels 2026-10-30: defaults allowlist/board, precedência tenant › pack › default, aliases, `{cap}` |
| `unit/w3-alcada.test.ts` | Task 8: modos de alçada, impacto/requiresFinance, status da fila, transições A7+alçada, KPIs, dedupe |
| `unit/cadastro.test.ts` | W3b: kinds efetivos/legado, 4 modos de alçada, readiness c/ kinds do tenant, packs, validadores (labels/roster/policy_kinds) |
| `integration/cadastro.test.ts` | W3b: 0013 + zero grant, packs, POST pack (Regra 1), alçada × pack, PUT alçada + packSwitched, Regra 5 no CRUD, 400s de settings, no_policy fail-closed, RLS |
| `integration/w3-pulse.test.ts` | Task 8: tenant vazio, 401/400, prioridade planRef, fontes KPI + exceções + números iguais entre lentes, fluxo alçada completo, RLS cross-tenant |
| `integration/wizard-api.test.ts` | W2 E2E (LLM mock): unlock 403/409, create/list/get, ditado → cartões tipados + rejeitados não persistem + cache, 422/502, Gap `invalid_reference` (ausente/versão/aposentado/cross-tenant), PATCH version/audit, happy → A4 run done, isolamento B |
| `integration/a1-curva.test.ts` | T-A1-ENG (mock LLM): M1+H2, M2, M3, M4, manual POST v1, H4 dedupe, M5 isolation + legacy `{growth}`, H5 roster |
| `integration/a7-orchestrator.test.ts` | T-A7-LEVE: M1 400/401/404/409 (a7_disabled, archived, cross-tenant), M2 matriz + ajv, M3 commit (zero escrita c/ commit=false; approve/escalate system; 409 closed/already_escalated; 400 commit_not_allowed), H2 provocations |
| `unit/a7-decision.test.ts` | W2b: máquina de estados A7 pura — transições, why ≥20, run_required/not_done/stale, papel |
| `unit/a7-orchestrate.test.ts` | T-A7-LEVE: matriz dos 3 vereditos, scope de exceções, provocations (A4 nunca, dedupe), pacote/opções, decisão system 403/409 |
| `integration/seed-demo-alcada.test.ts` | PO W3b: seed demo → active limiar 2, idempotente, não sobrescreve limiar, out_of_pack intocado, tenant vazio no_policy |
| `unit/execution-pulse.test.ts` | W4: buckets dia, limiar 15% (=15% não), block, aderência/janela, kind → reason |
| `integration/execution.test.ts` | W4: 0014 (FORCE RLS, grants, trigger, FK composta), POST/batch all-or-nothing/void/GET, Pulse warn/block + aderência, unapproved_plan, empty tenant, RLS cross-tenant |
| `unit/journey-conviction.test.ts` | W5: latência mediana/máx, alavancas (expedite nunca inventa $), roles/gaps, templates MD (lab vazio sem dígito), landSchema |
| `integration/journey.test.ts` | W5: 0015 (FORCE RLS, grants, fn definer amarrada a conviction), lab vazio sem número falso, happy path Qualidade (snapshot→steps→conviction GET json/md→sign-off→land thin + pack/alçada), 409 slug/400 link, RLS cross-tenant · 0016: land fn com dono NOBYPASSRLS simulado (rollback) + restaura `app.tenant_id` do lab |
| `unit/w6-task12.test.ts` | W6: `stepOrderGap`, `LAND_ROLES`, `isKnownKind`/`policyKindWarnings`, readiness `policy_kind_unknown` (warn, nunca block) |
| `unit/w7-plan-export.test.ts` | W7: papéis/formatos (400), payload + ajv (sem `reasonCandidates`, sem mutação), linhas exatas do CSV, null → célula vazia, filename sanitizado |
| `integration/plan-export.test.ts` | W7: ordem 401/403/400/409 sem audit; latest_run → 409; approve → 200 admin/domain_owner/finance (headers, sem ETag, plan = `a4_runs.plan` − reasonCandidates, planRef = Pulse, 3 audits); CSV (BOM, `#`, seções, números = JSON); versão superada → 409; RLS A/B; POST → 404 |
| `integration/journey-w6.test.ts` | W6: 0017 (definer/grants), 409 `steps_out_of_order`, matriz papel 403/201, link 400 byte-igual × 200 link, 0017 com dono NOBYPASSRLS (rollback), warnings em POST/PATCH policies + readiness |
| `integration/decision-events.test.ts` | W2b: approve/escalate HTTP+DB, contrato (ajv), audit_log, why rules, stale (versão/premissa), escalated→owner, RLS cross-tenant, 401 |
| `unit/ditado.test.ts` | W2: serviço do ditado sem rede — timeout, teto diário, cache por tenant, resolução de nó |
| `unit/curva.test.ts` | T-A1-ENG: `buildCurva` limits 5/6, window/horizon, profiles, determinism/clamp, params/schema, client/merge, pure ditado parse, ajv `$defs/curvaDemandaV1` |
| `integration/confirmed-at.test.ts` | 0010: confirm/unconfirm via PUT tenant-settings, carimbo do servidor, helper `unlock` sem alterar `state`, isolamento B |
| `integration/a4-readiness.test.ts` | W1b E2E: `/api/a4-readiness` vazio vs amostra, capacidade só via `node_capacity` corrente, nó aposentado, flag → contrato, isolamento B |
| `integration/helpers.ts` | Setup de dois tenants + migrate/seed + `ownerCreateScenario` (fixture owner, sem unlock) |
| `integration/rls.test.ts` | Isolamento RLS entre tenants + FK composta cross-tenant + 1 versão corrente por `stable_id` + premise_cards (FORCE RLS, FK composta nó/cenário, CHECK Gap) + W2 grants `scenarios` (insert/update próprio tenant, sem delete/cross-tenant) + FORCE RLS `a4_runs`/`scenarios` |
| `integration/api.test.ts` | E2E HTTP do cadastro + W0.1 (aliases, `stable_id`, `node_types` do tenant) + W1 Gap card (stable_id, versão/aposentado rejeitado, cross-tenant) |

---

## Fora deste repo (contexto Squad)

| Path | Descrição |
|------|-----------|
| `/workspace/docs/superpowers/specs/` | Specs/wires canônicos no box compartilhado (espelhados em `docs/product/`) |
| `/workspace/docs/superpowers/specs/infra/` | Compose de referência (este repo tem o seu na raiz) |

---

## Regras de manutenção do INDEX

1. **Ler** `INDEX.md` + `AGENTS.md` antes de qualquer mudança.
2. **Criar pasta nova** → adicionar linha nesta tabela (path + 1 frase).
3. **Mover/renomear** → atualizar paths aqui e nos links do `README`/`AGENTS`.
4. **Remover** → riscar/remover a linha no mesmo PR.
5. Não indexar `node_modules/`, `.env`, artefatos de build.
