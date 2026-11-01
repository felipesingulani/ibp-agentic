# A7 Orchestrator leve — contrato eng (Path C · T-A7-LEVE)

**Status: READY FOR ENG/UX — PO cravou escopo V0 2026-10-31 (`state_machine_only`, zero LLM)**  
Autor: Deivid (Arquiteto) · Eng **T-A7-LEVE** (Devi) · UX **T-A7-UX** (Didi) · QA **T-A7-LEVE** (Qualidade)  
Base: cravos PO Path C · stub W2b `src/a7/decision.ts` + `contracts/decision-event.schema.json` v0.2 · W3 Pulse/Alçada (`W3-PULSE-VISOES-API-CONTRACT.md`, `src/w3/snapshot.ts`, `exceptions.ts`) · packs `A7.mode=state_machine_only` · produto §A7 (loop orquestração) em fatia thin.

---

## 1. Escopo
- Endpoint novo **`POST /api/a7/evaluate`**: lê Pulse/`decision_events`/políticas (via snapshot W3 + fatos A7 existentes), **provoca stubs** A1–A3/A5/A6 e devolve veredito **`auto_policy` | `escalate_human` | `await_inputs`** + pacote mínimo.
- Máquina **determinística** (`state_machine_only`). **Zero LLM**, zero prosa narrativa, zero Gurobi, zero `POST /api/a4-runs`, zero write-back ERP.
- `commit=true` (opcional): persiste `decision_events` só quando o veredito permite (§4); pacote completo vai em **`audit_log.payload`** (sem migration / sem coluna nova).

## 2. Fora de escopo / anti-goals
- Takeaways LLM · ditado · A4 solver (CBC/Gurobi) · Journey write · Execution write · ERP.
- Tabelas/migrations novas · alterar required de `decision-event.schema.json` · Med/Low T-DM W0.2 · P3 ditado LLM.
- Endpoints A2/A3 reais · chamar ditado/A1 write · inventar KPI.
- Auto-aprovar com alçada Finance ativa (`requiresFinance=true`) — sempre escala.

## 3. API — `POST /api/a7/evaluate`
**Auth:** `x-tenant-id` + RLS (igual DecisionEvent). `x-user-id` opcional (stub).  
**Body** (strict, `additionalProperties:false`):
```json
{ "scenarioId": "<uuid>", "commit": false }
```
`commit` default `false`.

**Response 200** — valida contra **`contracts/a7-orchestration.schema.json`** (Devi cria; campos abaixo):
| Campo | Regra |
|---|---|
| `schema` | const `"a7.orch.v1"` |
| `scenarioId` / `scenarioVersion` | cenário corrente avaliado |
| `verdict` | `auto_policy` \| `escalate_human` \| `await_inputs` |
| `provocations[]` | `{ agent: A1\|A2\|A3\|A5\|A6, code, severity: info\|warn\|block, detail }` — **A4 nunca** |
| `package` | `{ premises[], violations[], options[] }` (arrays; podem vazios) |
| `basis` | `{ hasRun, runStatus, runStale, requiresFinance, impactMi, alcadaMi, decisionState, pulseExceptionsCount }` |
| `committedEventId` | uuid \| null (só se `commit` gravou) |

**Erros estáveis:**
| HTTP | code | Quando |
|---|---|---|
| 404 | `not_found` | cenário inexistente / outro tenant |
| 409 | `scenario_archived` | cenário arquivado |
| 409 | `a7_disabled` | `agents.A7.enabled !== true` (pack + override `tenant_settings`) |
| 409 | `decision_closed` | commit e já `approved` |
| 409 | `already_escalated` | commit escalate e já escalado p/ mesmo destino |
| 400 | `validation_failed` | body inválido |
| 400 | `commit_not_allowed` | `commit=true` com `verdict=await_inputs` |

**Grants/migrations:** nenhum. Só SELECT já concedido + INSERT `decision_events`/`audit_log` já existentes.

## 4. Veredito (ordem determinística)
Reuse fatos: `decisionState` / `runIsStale` / `requiresFinance` / `whyMinFor` de `src/a7/decision.ts` + `src/w3/alcada.ts`; exceptions = mesma lista de `buildExceptions` no snapshot W3 **filtrada ao `scenarioId`** (mais readiness/alcada globais que bloqueiam).

1. Arquivado → **409** (não vira veredito).
2. A7 off → **409 `a7_disabled`**.
3. **`await_inputs`** se: sem run `feasible|partial` na **versão corrente**, **ou** `runStale`, **ou** readiness `state=block` no tenant, **ou** existe exception `severity=block` com `source=readiness` (cadastro incompleto).
4. **`escalate_human`** se: `requiresFinance`, **ou** exception `block` (qualquer fonte restante no cenário), **ou** run `partial`, **ou** reason `warn|block` no run, **ou** `decisionState=escalated` (já aguarda humano — evaluate devolve pacote; commit escalate → 409).
5. **`auto_policy`** só se: `decisionState=pending`, run `feasible` (não partial), `!runStale`, `!requiresFinance`, zero exceptions `block`, zero reasons `warn|block`.

## 5. `commit`
- **`auto_policy`:** INSERT `decision_events` `action=approve`, `actor.role=system`, `userId=null`, `runId`=run corrente, `why` = `a7.auto_policy.v1:<code>` (≤120), `impactMi`/`alcadaMi` quando conhecidos, `exportRef=null`. Caminho: helper em `src/a7/` que aplica as **pré-condições de run** de `evaluateDecision(approve,…)` **bypassando** checagens de papel humano (só `system`). Mesmo `pg_advisory_xact_lock` por cenário do POST decision-events.
- **`escalate_human`:** INSERT `escalate`, `actor.role=system`, `escalateTo` = `finance` se `requiresFinance` senão `domain_owner`, `why` = `a7.escalate.v1:<code>`. Pacote completo + provocations em **`audit_log.payload`** (`action` existente de create/decision; espelhar padrão Task 7/8).
- **`await_inputs`:** nunca grava → 400 `commit_not_allowed`.
- Evaluate sem commit **nunca** escreve.

## 6. Provocations (stubs — sem rede / sem LLM)
| Agent | Quando | `code` (exemplos estáveis) |
|---|---|---|
| **A1** | card `CurvaDemanda` v1 com `gapCode` ∈ hist_* / anchor_missing no cenário | `need_curve` · `hist_gap` · `anchor_missing` |
| **A2** | exception `premise_gap` / readiness capacidade ligada a supply/rede | `supply_gap` (detail.id = exception.id) |
| **A3** | exception execução (`source=execution`) no cenário | `execution_exception` |
| **A5** | `alcada.mode=misconfigured` \| reasons/policy do run \| `requiresFinance` | `alcada_misconfigured` · `policy_violation` · `alcada_required` |
| **A6** | cada exception do cenário (e blocks de readiness) | `pulse_exception` (detail = id/source/severity) |
| **A4** | **proibido** na lista | — |

Sem provocação aplicável → `[]`. Dedupe por `(agent, code, detail.id?)`.

## 7. Pacote mínimo
- **`premises`:** até 10 cards do cenário `{ id, type, status, version }` (Gap + CurvaDemanda + Investimento primeiro).
- **`violations`:** exceptions `block|warn` do cenário `{ id, source, severity, summary }` (cap 20).
- **`options`:** lista fechada V0: `rerun_a4_human` · `fix_readiness` · `open_alcada` · `edit_premises` · `wait` — só as acionáveis pelo `basis` (ex. `open_alcada` se `requiresFinance`; `fix_readiness` se await por readiness).

## 8. Gate / arquivos
- Código em `src/a7/` + `src/http/a7*.ts` (ou rota em `app.ts`). Gate regra 5: sem LLM/prompt/narrativa/`fetch`/ditado; **adicionar** ban a `a4-runs` POST / Gurobi / optimize no path A7.
- Reuse `loadW3Snapshot` (ou fatia) — **não** duplicar SQL de exceptions.
- UI `public/index.html`: **intocada** no eng; Didi overlay depois.

## 9. DoD
**Eng (Devi):** schema `a7-orchestration.schema.json` · rota · matriz unitária dos 3 vereditos + commit approve/escalate/403–409 · `npm test` green · gate green · evidence `docs/architecture/T-A7-LEVE-EVIDENCE.md`.  
**UX (Didi):** painel veredito + pacote + provocations; CTA commit só com Go API; labels do contrato; sem copy inventada.  
**QA (Qualidade):** checklist `QA-ACCEPTANCE-T-A7-LEVE.md` — Must: A7 off→409 · await sem run · escalate com alçada · auto_policy+commit→approve system · commit await→400 · UI md5 eng intocado · regressão Pulse/DecisionEvent.

## 10. Sugestão de split
1. Devi eng API (+ testes) → Deivid review DoD → publish API se precisar.  
2. Didi UX overlay.  
3. Qualidade acceptance prod.

Pack note: `generic` hoje tem `A7.enabled=false` — fixture QA deve ligar A7 no tenant de teste (override settings), sem mudar E0.
