# T-A7-LEVE — Evidence (Eng · Devi)

**Data:** 2026-10-31 18:40 (BRT, UTC-3) · **Contrato:** `docs/architecture/A7-ORCHESTRATOR-LEVE-CONTRACT.md` md5 `65edbebcfc7c372f92664d93004218aa` (intacto) · **QA:** `QA-ACCEPTANCE-T-A7-LEVE.md`
**Status:** box-only, **não publicado** (Deivid publica após review). Sem git push / CloudAgent.

## Entregue
| Arquivo | O quê |
|---|---|
| `contracts/a7-orchestration.schema.json` | Resposta `a7.orch.v1` (Draft 2020-12, `additionalProperties:false`; agent ∈ A1/A2/A3/A5/A6 — **A4 fora do enum**) |
| `src/a7/orchestrate.ts` | Puro: `decideVerdict` (await → escalate → auto; fail-closed), `buildProvocations` (dedupe agent/code/detail.id), `buildPackage` (≤10 premissas, ≤20 violações, opções do basis), `whyFor` |
| `src/a7/roster.ts` | `assertA7Enabled` (pack + `tenant_settings.agent_roster`) → 409 `a7_disabled` |
| `src/a7/system-decision.ts` | Decisão `actor.role=system` sobre `evaluateDecision` (mesmas pré-condições de run / why) |
| `src/a7/contract.ts` | + `assertA7Orchestration` (ajv runtime) |
| `src/http/a7.ts` + mount em `src/http/app.ts` | `POST /api/a7/evaluate` (zod `.strict()`, `withTenant`/RLS, advisory lock por cenário no commit) |
| `harness/scripts/w2-grep-gate.sh` | Regra 5 cobre `http/a7*.ts`; **regra 12**: path A7 sem `a4-runs`/INSERT·UPDATE `a4_runs`/import solver/`executeRun`/Gurobi/cplex/optimize/cliente de rede |
| `test/unit/a7-orchestrate.test.ts` (7) · `test/integration/a7-orchestrator.test.ts` (5) · `test/support/schemas.ts` (`validateA7Orch`) | Matriz + commit + isolamento + ajv |
| `INDEX.md` | src/a7, http/a7, contrato, gate regra 12, testes |

## Comportamento (resumo)
- Ordem de erro: 401 sem tenant → 400 `validation_failed` (body/extra keys) → 404 `not_found` (inexistente/outro tenant via RLS) → 409 `scenario_archived` → 409 `a7_disabled`.
- Veredito: `await_inputs` (sem run feasible|partial na versão corrente · stale · readiness block · exception readiness block) › `escalate_human` (requiresFinance · exception block · partial · reason warn|block · já escalado) › `auto_policy` (pending + feasible + limpo).
- `commit=false`: zero escrita. `commit=true`: auto → `approve`, escalate → `escalate` (`escalateTo` finance|domain_owner derivado), `actor_role=system`, `actor_user_id NULL`, `why = a7.<verdict>.v1:<code>`, `run_id` = run corrente; `audit_log.payload` = campos v0.2 + `a7 {schema, verdict, code, reasons, provocations, package, basis, requestedBy}`. await+commit → 400 `commit_not_allowed`; approved → 409 `decision_closed`; escalated → 409 `already_escalated`.

## QA map
| Item | Teste |
|---|---|
| M1 | integration `M1` (400×4, 401, 409 a7_disabled commit false/true sem escrita, 404, 409 archived) |
| M2 / H3 / H4 | integration `M2/H4` (readiness block, sem run, failed, versão antiga, stale, partial, reason warn, info→auto, alçada) + unit matriz/pacote; cada 200 validado por ajv |
| M3 | integration `M3` ×2 (counts iguais c/ commit=false; approve/escalate system; payload; 409/400; Finance humano aprova depois via `/api/decision-events`) |
| M4 | `npm run gate` green (regra 12 + probe negativo local); `public/index.html` md5 `b04fef66c50f8f385cf99036ed23c825` igual; suíte anterior 169/169 intacta |
| H1 | integration `M1` (tenant B → 404 com commit) |
| H2 | integration `H2` + unit provocations (A4 nunca, dedupe) |

## Resultado
`npm test` **181/181 pass** (169 baseline + 7 unit + 5 integration) · `npm run typecheck` ok · `npm run gate` ok (src/db/test/contracts/solver/packs). Log: `docs/architecture/T-A7-LEVE-test.log`.
**Sem migration** (última segue `0018`), **sem UI**, **zero LLM / A4 run / Gurobi / ERP write-back**.

## Ambiguidades (decididas fail-closed, sem escopo novo — confirmar com PO/QA)
1. Cenário já `approved` sem outra condição: contrato não tem veredito → `escalate_human` code `decision_closed` (nunca auto); commit → 409.
2. Re-commit em `escalated`: §4 diz 409 `already_escalated`; QA M3 diz "mesmo destino". Implementado: 409 para **qualquer** destino.
3. "403" no DoD Eng: tabela de erros não lista 403; existe só o defensivo `alcada_finance_required` (approve system com requiresFinance — inalcançável pela matriz).
4. Nome do evidence: brief dizia `T-A7-LEVE-ENG-EVIDENCE.md`; seguido o contrato (`T-A7-LEVE-EVIDENCE.md`).
5. Resposta 200 é o objeto `a7.orch.v1` **sem** envelope `{data}` (contrato: "Response 200 valida contra o schema"); demais APIs usam `{data}`.
6. Sem `x-tenant-id` → 401 (middleware existente), não 400.
7. `basis` no commit reflete a avaliação pré-commit; `runStatus` sem run elegível = status do último run da versão corrente.
