# QA aceitação — T-A7-LEVE (orchestrator state_machine_only)

Status: **READY Qualidade · 2026-10-31** · task **T-A7-LEVE** · base `A7-ORCHESTRATOR-LEVE-CONTRACT.md` (md5 `65edbebc…`) · **Go PO**.
> ✅ Contrato fechado. Smoke = pós DoD eng Devi (+ UX Didi se overlay). Fixture: tenant `qa-a7-*` com **A7.enabled=true** (override settings); nunca E0 `e5cf…`. UI eng intocada (`b04fef66…` até overlay Didi).

## Cravos (PO — CRAVADO 2026-10-31; Go eng ativo)
1. `state_machine_only` · **zero LLM** / prosa / Gurobi / ERP / `POST /api/a4-runs`.
2. `POST /api/a7/evaluate` · schema `a7.orch.v1` · vereditos `auto_policy|escalate_human|await_inputs`.
3. Provocations stub A1–A3/A5/A6 (**A4 nunca**).
4. `commit=true` grava DecisionEvent `actor.role=system` + pacote no `audit_log`; `await_inputs`+commit → 400.
5. Sem migration / grant novo.

## DoD (contrato §9, citado)
- A7 off → 409 `a7_disabled` · await sem run · escalate com alçada · auto_policy+commit → approve system · commit await → 400 · UI md5 eng intocado · regressão Pulse/DecisionEvent.

## Must (bloqueia ship)
- [ ] **M1 Gate A7** — A7 off (pack/settings) → `POST /api/a7/evaluate` **409 `a7_disabled`** (commit true/false); A7 on + cenário ok → 200 `schema=a7.orch.v1`. Cenário outro tenant / inexistente → 404; arquivado → 409 `scenario_archived`. Body inválido → 400 `validation_failed`.
- [ ] **M2 Matriz veredito** (determinística, mesmo fixture):
  1. sem run `feasible|partial` na versão corrente **ou** `runStale` **ou** readiness `block` → `await_inputs`;
  2. `requiresFinance` **ou** exception `block` **ou** run `partial`/reason warn|block → `escalate_human`;
  3. `decisionState=pending` + run `feasible` + !stale + !requiresFinance + zero block → `auto_policy`.
  - `basis` preenchido; `provocations[]` sem agent A4; `package` com premises/violations/options só acionáveis.
- [ ] **M3 Commit** — `commit=false` → zero INSERT `decision_events`/`audit_log` A7. `auto_policy`+`commit=true` → 200 + evento `action=approve` `actor.role=system` `userId=null` `why` prefix `a7.auto_policy.v1:` + `committedEventId`. `escalate_human`+commit → `action=escalate` `escalateTo` finance|domain_owner + pacote no `audit_log.payload`. `await_inputs`+commit → **400 `commit_not_allowed`**. Já `approved` → 409 `decision_closed`; re-escalate mesmo destino → 409 `already_escalated`.
- [ ] **M4 Anti-escopo + regressão** — grep/gate: path A7 sem LLM/fetch/ditado/`a4-runs` POST/Gurobi. UI `public/index.html` md5 **igual pré-eng** (até overlay Didi). Pulse `GET /api/visoes/*` + `GET /api/alcada/queue` + DecisionEvent humano (Task 7) green; E0 intocado; sales_history count estável.

## High
- [ ] **H1 Isolamento** — tenant B não avalia/commit cenário de A (404); eventos só no tenant certo (RLS).
- [ ] **H2 Provocations** — A1 `hist_gap`/`need_curve` com CurvaDemanda gap; A5 `alcada_required` com requiresFinance; A6 `pulse_exception` por exception; dedupe `(agent,code,detail.id)`.
- [ ] **H3 Options** — `open_alcada` só se requiresFinance; `fix_readiness` só se await por readiness; `wait`/`edit_premises`/`rerun_a4_human` conforme basis (sem inventar).
- [ ] **H4 Schema** — response 200 valida `contracts/a7-orchestration.schema.json` (ajv); `additionalProperties` false no body.

## Med
- [ ] **D1** UX (pós overlay): painel veredito + pacote + provocations; CTA commit só com API green; labels do contrato.
- [ ] **D2** Evidência `T-A7-LEVE-EVIDENCE.md` + log teste; fixture `qa-a7-*` documentada.
- [ ] **D3** Pack `generic` A7=false default; override só no tenant QA.

## Evidência
md5 contrato/API/UI · HAR `POST /api/a7/evaluate` · Neon `decision_events` + `audit_log.payload` · matriz 3 vereditos · GREEN/RED no Squad.

## Fora
LLM prose · A4 solver · Journey/Execution write · ERP · Med/Low T-DM · P3 ditado · endpoints A2/A3 reais.
