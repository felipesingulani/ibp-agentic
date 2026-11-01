# Decision-Ready Scenario Pack — contrato arch (T-BIZ-ARCH · AR-01…AR-11)

**Status: READY FOR ENG — PO Go 2026-10-31 (Approach B, ordem §10 do design)**
Autor: Deivid (Arquiteto) · Eng **T-BIZ-*** (Devi) · UX (Didi) · QA `QA-ACCEPTANCE-T-BIZ-*.md` (Qualidade)
Base: `docs/superpowers/specs/2026-10-31-domain-rewire-business-gaps-decision-ready-design.md` §5/§8.2/§10/§11 · `main` @ `2bf1f755` · A4 worker GREEN (`A4-SOLVER-WORKER-CONTRACT.md`) · A7 (`A7-ORCHESTRATOR-LEVE-CONTRACT.md`) · W3 (`W3-PULSE-VISOES-API-CONTRACT.md`).

---

## 0. Cravos (resumo)
1. **Zero migration.** Tudo on-read de colunas que já existem + chaves JSON novas em colunas `jsonb` já existentes (`a4_runs.plan`, `skus.attrs`, `policies.body`, `audit_log.payload`). Nenhuma env nova (AR-08/AR-10).
2. **Um número, uma fonte:** módulo único `src/w3/finance.ts` (WC/MC/payback) + `src/cadastro/gates.ts` (avaliador de gates). Pulse, Visões, compare, alçada, decisão e A7 só consomem (AR-04).
3. **`null` + `nullReason`, nunca 0 silencioso;** toda driver devolve `source` (AR-01/AR-03).
4. **Gate de cadastro é server-side:** `POST /api/a4-runs` → `409 cadastro_gate_block`; a UI só espelha via `GET /api/scenarios/:id/gates` (mesmo avaliador) (AR-07).
5. **Plano operável é aditivo e honesto:** `plan.lines/capacity/activeConstraints` em `a4_runs.plan`; A4 piloto = 1 período e só emite `transferir|expedir` — `produzir|comprar` reservados, nunca fingidos (AR-06).

---

## 1. Escopo / fora
**Dentro (V0):** contratos de shape + regras para T-BIZ-CAD-GATES, T-BIZ-WC-V0, T-BIZ-MARGIN-STUB, T-BIZ-A4-PLAN-UI, T-BIZ-COMPARE-STRIP, T-BIZ-FILTERS-LENS (query only) e o delta A7.
**Fora (anti-goals):** migration · env nova · NPV/TIR/impostos/depreciação/financiamento · forecast/P10–P90 · A4 multi-período/Gurobi · mudar o LP (`src/a4/model.ts`) ou o worker · ERP · Journey/Execução live · delegação/SLA de alçada · LLM · ligar `A7.enabled` (só depois do pack) · UI (`public/index.html`) neste contrato — cada task UX tem seu próprio md5.

---

## 2. Realidade do schema (o que já existe × JSON-only)

| Dado | Fonte que **já existe** (coluna) | Chave JSON nova (sem migration) |
|---|---|---|
| Custo unitário SKU | `skus.unit_cost numeric` | — |
| Preço unitário SKU | — | `skus.attrs.unit_price` (número; escrito pelo write de cadastro existente) |
| Família SKU | `skus.family text` | — |
| Capacidade nó | `node_capacity.capacity_t_month` (`is_current`, > 0) | — |
| Volume / vigência contrato | `supplier_contracts.obligations.{min_volume,max_volume}` · `valid_from`/`valid_to date` | — |
| DSI | linha `policies` corrente do grupo `inventory` (coluna `body jsonb`) | `body.dsi_days` (número; chave cravada aqui — hoje nenhum código lê DSI) |
| DSO / DPO | linha `policies` corrente do grupo `working_capital` (coluna `body jsonb`) | `body.dso_days`, `body.dpo_days`; ausente → default pack `DSO=45`, `DPO=30` (`packs/*` config, **não env**) |
| Driver financeiro rascunho (FD-06) | `finance_drivers.mapping` (jsonb) | `mapping[i].status = "draft"` → warn |
| Capex | `premise_cards.fields.impactMi` (type `Investimento`) via `scenarioImpact()` | — |
| Preço/custo por cenário | — | `premise_cards.fields.{unitPrice,unitCost}` (opcional, por SKU) |
| Plano A4 | `a4_runs.plan jsonb` (`PlanOut`: `flows/local/unmet/utilization/totals/period`) | `plan.lines`, `plan.capacity`, `plan.activeConstraints`, `plan.planShapeVersion` |
| Snapshot da decisão | `audit_log.payload jsonb` | `payload.pack` |
| Moeda / uom | `tenant_settings.currency` / `uom` | — |

Grupos `inventory|working_capital|service` resolvidos pelo vocabulário do tenant (`effectivePolicyKinds`/`KIND_GROUPS`, F-1) — nunca string de kind fixa. Sem DSI na política → `dsi` = `null` + `nullReason:"no_policy"` (não há default de DSI; demo seed 45d).

---

## 3. AR-01…AR-11

### AR-01 · `contracts/scenario-finance.schema.json` (novo, `$id …/scenario-finance.schema.json`, `financeVersion: "sf.v0"`)
Shape do `ScenarioFinance` (todo valor numérico = `{ value: number|null, nullReason?: string, source: string }`, moeda em **mi** 2 casas, `uom` do tenant):
```json
{
  "financeVersion": "sf.v0",
  "formulaVersions": { "wc": "wc_days_v0", "mc": "mc_stub_v0" },
  "scenarioId": "uuid", "scenarioVersion": 3, "runId": "uuid|null",
  "cadastroVersion": 41, "stale": false,
  "period": "2026-09", "periodDays": 30, "horizonMonths": 24,
  "revenue": V, "cogs": V, "logisticsCost": V, "mc": V,
  "deltaMc": V, "capexMi": V,
  "wc": { "inventory": V, "receivables": V, "payables": V, "total": V },
  "deltaWc": V,
  "paybackMonths": V, "paybackWithWcMonths": V,
  "drivers": [{ "key": "dsi|dso|dpo|unit_price:<sku>|unit_cost:<sku>", "value": 45, "source": "premise|cadastro|policy|default_pack", "ref": "POL-01 v2|null" }],
  "missing": [{ "entity": "sku", "stable_id": "…", "code": "SKU-X", "field": "unit_price|unit_cost", "cta": "/cadastro/skus/<stable_id>" }]
}
```
`deltaMc/deltaWc/payback*` são `null` + `nullReason:"no_baseline"` quando não há plano vigente para comparar.
**`nullReason` enum (sf.v0):** `no_plan` · `no_price` · `no_cost` · `no_baseline` · `no_payback_in_horizon` · `payback_beyond_horizon` · `cost_breakdown_unavailable` · `legacy_run` · `no_policy`. Mapa pt-BR estende `journey/conviction.ts` (fonte única de rótulos).

### AR-02 · Fórmulas versionadas (retornadas na API em `formulaVersions`)
`wc_days_v0` (período p do run, `dias = dias do mês de p` se `YYYY-MM`, senão `30` com source `default_pack`):
`Receita = Σ volume×preço` · `CPV = Σ volume×custo` (volume = `served` do run por nó×SKU) · `Estoque = CPV/dias×DSI` · `CR = Receita/dias×DSO` · `CP = CPV/dias×DPO` · `WC = Estoque + CR − CP` · `ΔWC = WC_cenário − WC_baseline`.
`mc_stub_v0`: `MC = Receita − CPV − CustoLogístico` (`CustoLogístico` = Σ `plan.lines[].cost` não-nulos; quebra por tipo se existir, senão linha única + `cost_breakdown_unavailable`) · `ΔMC` mensal (período = mês) · `capexMi` = AR-04 · `payback = capex/ΔMC_mensal` · `paybackWithWc = (capex+ΔWC)/ΔMC_mensal` · `ΔMC ≤ 0` → `null` + `no_payback_in_horizon` (UI texto "não se paga no horizonte") · `payback > horizonMonths` → `null` + `payback_beyond_horizon` (UI "> horizonte (N meses)").
Projeção 1 período → horizonte = **linear**, rotulada `"projeção linear v0"` em `source`. `horizonMonths` ← premissa do cenário (`fields.horizonMonths`) senão default pack **24** (`default_pack`).
Qualquer `preço`/`custo` faltante em SKU com volume > 0 → agregados dependentes (`revenue|cogs|mc|wc.*|delta*|payback*`) = `null` + `no_price|no_cost`, e item em `missing[]`. **Nunca soma parcial.**

### AR-03 · Precedência de drivers
`premissa do cenário > cadastro (skus.unit_cost / attrs.unit_price) > política vigente > default_pack`. DSI/DSO/DPO: política > default_pack (premissa só se o card trouxer explicitamente). `source` + `ref` (código + versão) sempre presentes. Teste das 4 combinações (EN-05).

### AR-04 · Fonte única de capex
`capexMi` **= `scenarioImpact(cards).impactMi`** (`src/w3/alcada.ts`) — sem reimplementar. Teste de igualdade alçada × pack (EN-04, fixture 3,4).

### AR-05 · Filtros (contrato de query — T-BIZ-FILTERS-LENS, paralelizável)
`GET /api/pulse/summary|/api/pulse/exceptions|/api/visoes/:lens` aceitam `?node=<stable_id|code>[,…]&family=<f>[,…]` (AND entre params, OR dentro). Filtro aplicado **no snapshot W3** (uma vez por request). Valor desconhecido → **200 vazio**, nunca 500. Resposta inclui `filter: { node:[], family:[], applied:true }` e cada KPI não filtrável vem com `filterable:false` (V0: `alcada_*`, `decision_*`, `wc` quando a decisão é por cenário) — UI mostra chip "não filtrável".

### AR-06 · Plano operável (`a4_runs.plan`, `planShapeVersion: "plan.v1"`)
Chaves **aditivas** gravadas por `executeRun`/`explain` em runs novos; `PlanOut` atual intocado. **Deviation do design:** o design pedia bump em `a4-run-summary.schema.json`, mas `plan` é irmão de `summary` em `runOut()` e o summary é `additionalProperties:false`/always-on → shape vai num schema novo `contracts/a4-run-plan.schema.json`; `a4-run-summary.schema.json` **não muda**.
```json
"lines": [{ "period": "2026-09", "kind": "transferir|expedir|produzir|comprar", "from": "stable_id|null", "to": "stable_id",
            "sku": "stable_id", "qty": 120.0, "uom": "t", "cost": 3600.0, "costNullReason": null }],
"capacity": [{ "node": "stable_id", "code": "CD3", "period": "2026-09", "cap": 1000, "used": 1180, "gap": -180, "pct": 1.18 }],
"activeConstraints": [{ "kind": "contrato|capacidade|politica", "ref": "stable_id", "code": "CT-101", "name": "…", "modeled": true, "notModeledReason": null }]
```
- `transferir` ← `flows` (`from/to` = origem/destino da rota, `cost = qty × routes.cost_per_ton`, `null` + `no_cost` se rota sem custo). `expedir` ← `local` (`from=null`, `cost=null` + `cost_breakdown_unavailable`). `produzir|comprar` **reservados**: o LP piloto não tem essas variáveis → nunca emitidos em V0.
- `capacity` ← `utilization` + `unmet`: `gap = cap − used − unmet_no_nó` (negativo = falta). Inclui nós em escopo **sem** capacidade com `cap:null`.
- `activeConstraints` lista **todos** os contratos vigentes do escopo + capacidades + políticas efetivamente usadas. Contrato não modelado porque `tenant_settings.supply_external_in_scope=false` aparece com `modeled:false, notModeledReason:"supply_external_out_of_scope"` — causa-raiz do "0 restrições" de hoje (`loadSnapshot` só carrega contratos com o flag). UI conta modelados e mostra os não modelados; **nunca "0" com contratos vigentes**. Demo: flag ligado via write de cadastro existente (seed, sem migration).
- Run legado (sem `planShapeVersion`): `GET` deriva `lines/capacity` on-read de `flows/local/utilization`; `activeConstraints = null` + `legacy_run`.
- 1 período ⇒ 1 coluna rotulada; nada de horizonte fake.

### AR-07 · Gates de cadastro + `409 cadastro_gate_block`
Avaliador puro `evaluateGates(facts, scope) → { state: "ok"|"warn"|"block", items[] }` em `src/cadastro/gates.ts`, usado por:
`GET /api/scenarios/:id/gates` (hint UI, 200 sempre) · `POST /api/a4-runs` · `POST /api/decision-events`.
**Escopo do cenário** = nós de `premise_cards.node_id` / `fields.nodeId` (NovaFilial, Gap) ∪ nós com demanda no período do run; SKUs com demanda nesses nós ∪ SKUs citados em premissa; contratos vigentes cujo `sku_ids ∩ SKUs do escopo ≠ ∅`. Escopo vazio → escopo global (fail-closed).

| Regra | Sev | Fato |
|---|---|---|
| `node_without_capacity` | block | nó do escopo sem `node_capacity` corrente > 0 (FIL-RAO) |
| `contract_without_volume` | block | contrato do escopo sem `obligations.min_volume` e sem `max_volume` (CT-104) |
| `contract_out_of_validity` | block | `valid_from`/`valid_to` nulos ou não cobrem o período do run (CT-104) |
| `sku_without_cost` | block | SKU do escopo sem custo em premissa **e** sem `skus.unit_cost` |
| `sku_without_price` | warn | idem preço (WC/MC ficam `no_price`; não impede o solver) |
| `finance_driver_draft` | warn | `finance_drivers.mapping[]` com `status:"draft"` ou `regra` vazia (FD-06) |

Resposta (shape aninhado **cravado** pelo design/QA; emitido via `res.status(409).json` como o 503 do A4, não pelo `HttpError` padrão):
```json
409 { "error": { "code": "cadastro_gate_block",
  "items": [{ "entity": "node|contract|sku|finance_driver", "stable_id": "…", "code": "FIL-RAO", "rule": "node_without_capacity", "severity": "block", "cta": "/cadastro/nodes/<stable_id>" }] } }
```
Ordem no `POST /api/a4-runs`: zod → preflight solver 503 (A4 §4.3, intocado) → cenário 400 → readiness `409 a4_not_ready` → **gates `409 cadastro_gate_block`** → INSERT. Nenhum run criado no 409.
Decisão (`POST /api/decision-events`): `block` → mesmo 409; `warn` → `why.length ≥ 20` senão `400 invalid_input {field:"why", rule:"gate_warn_min_20"}`.
Selo cadastro por escopo: `GET …/gates` devolve `seal: { global: 1.0, scenario: { blocks: 2, warns: 1 } }`.

### AR-08 · Sem migration
Finance e gates calculados **on-read**. Decision event grava em `audit_log.payload.pack` (mesma transação, append-only): `{ financeVersion, formulaVersions, runId, scenarioVersion, cadastroVersion, capexMi, deltaWc, deltaMc, paybackMonths, paybackWithWcMonths, gates:{state,items} }`. `decision-event.schema.json` **sem** mudança de `required`.

### AR-09 · RLS
Tudo via `withTenant` (`app.tenant_id`); nenhuma função `SECURITY DEFINER` nova, nenhuma porta cross-tenant; baseline/compare só dentro do mesmo tenant; filtros AR-05 são predicados sobre o snapshot já filtrado por FORCE RLS.

### AR-10 · Env
Nenhuma env nova (só `A4_SOLVER_URL`/`A4_SOLVER_SECRET` já em prod). Defaults (`DSO=45`, `DPO=30`, `horizonMonths=24`, `periodDays=30` fallback) em config do pack (`packs/*`), versionados.

### AR-11 · A7
`POST /api/a7/evaluate` passa a ler `ScenarioFinance` + gates. `auto_policy` exige as condições atuais **e** `deltaMc.value > 0` **e** `capexMi ≤ alcadaMi` (já coberto por `¬requiresFinance`) **e** `gates.state ≠ "block"`. `gates.state = block` → `await_inputs` (code `cadastro_gate_block`, option `fix_readiness`); `deltaMc` null/≤0 → `escalate_human` (code `finance_incomplete|no_margin`). Pacote A7 inclui `pack` (mesmo objeto de AR-08). `a7-orchestration.schema.json` bump minor aditivo.

---

## 4. Endpoints (delta)
| Método | Path | Task | Nota |
|---|---|---|---|
| GET | `/api/scenarios/:id/gates` | CAD-GATES | hint UI; 200 `{state, items, seal}` |
| POST | `/api/a4-runs` | CAD-GATES | + `409 cadastro_gate_block` |
| POST | `/api/decision-events` | CAD-GATES / WC | + 409 block · why ≥ 20 em warn · `payload.pack` |
| GET | `/api/scenarios/:id/finance[?run_id=]` | WC-V0 + MARGIN | `ScenarioFinance` (run = último feasible\|partial da versão corrente) |
| GET | `/api/visoes/finance` · `/api/pulse/summary` | WC-V0 | KPI `wc` sai de `not_computed_v0` quando há run válido; `no_plan` sem run |
| GET | `/api/a4-runs/:id` | PLAN-UI | `plan.lines/capacity/activeConstraints` |
| GET | `/api/scenarios/:id/compare` | COMPARE-STRIP | `{ baseline: ScenarioFinance+svc/util/gap \| null, scenario: …, deltas, baselineRef }`; baseline = `resolvePlanRef()` `approved`; sem → `baseline:null` + `no_baseline` |
| GET | pulse/visoes `?node&family` | FILTERS-LENS | AR-05 |

Papéis: GETs = papéis atuais de leitura; finance/compare legíveis por `finance|domain_owner|admin` (+ quem já lê Visões).

---

## 5. Acceptance — Must eng (Devi)
- **M1** EN-01..05 unit verdes (WC à mão · `no_price` nunca 0 · payback `no_payback_in_horizon` · `capexMi == scenarioImpact` · precedência 4 combos).
- **M2** EN-09/10: FIL-RAO → 409 com item `FIL-RAO/node_without_capacity`; CT-104 → 409 `contract_out_of_validity|contract_without_volume`; só FD-06 warn → 202; nenhum run criado no 409.
- **M3** `GET …/gates` e `POST /api/a4-runs` retornam **os mesmos items** para o mesmo estado (teste de paridade).
- **M4** EN-06: `GET /api/visoes/finance` com run válido → `wc.value != null`, reason ≠ `not_computed_v0`.
- **M5** EN-11: run novo → `plan.planShapeVersion="plan.v1"`, `lines.length>0`, `activeConstraints` contém todos os contratos vigentes do escopo (com `modeled`); run legado → derivado + `legacy_run`.
- **M6** EN-12: approve grava `audit_log.payload.pack`; warn exige why ≥ 20.
- **M7** AR-11: A7 não dá `auto_policy` com gate block ou ΔMC ≤ 0 (teste de máquina).
- **M8** EN-13 regressão: A1, A7 evaluate, alçada fail-closed, stale 409, export W7, A4 503 — `npm test` + gate verdes.
- **M9** `git diff --stat db/migrations` vazio · nenhuma env nova · UI md5 inalterado nas tasks não-UX.
- **M10** schemas novos (`scenario-finance`, `a4-run-plan`) validados em runtime (ajv) na saída + listados em `contracts/README.md` e INDEX.

## 6. Fatiamento (ordem §10 do design)
1. **T-BIZ-CAD-GATES** (AR-07, M2/M3) → 2. **T-BIZ-WC-V0 + T-BIZ-MARGIN-STUB** (AR-01..04/08, M1/M4/M6) → 3. **T-BIZ-A4-PLAN-UI** (AR-06, M5) → 4. **T-BIZ-COMPARE-STRIP** → 5. **T-BIZ-FILTERS-LENS** (AR-05, paralelo desde 1). A7 delta (AR-11, M7) entra com 2. Depois: `A7.enabled` no demo.

## 7. Riscos / abertos (default cravado)
| Item | Default | Reabre se |
|---|---|---|
| Demo sem preço/custo por SKU | seed `skus.unit_cost` + `attrs.unit_price` dos 4 SKUs via write de cadastro | Felipe preferir premissa |
| Demo com `supply_external_in_scope=false` | ligar no seed demo; senão UI mostra "N contratos vigentes · não modelados" | — |
| Volume = `served` do run (não demanda) | margem do que o plano entrega | forecast entrar |
| `expedir` sem custo no LP | `cost:null` + `cost_breakdown_unavailable` | worker expor quebra |
| Shape 409 aninhado ≠ `HttpError` padrão | aninhado (design + QA curl) | PO pedir padronização global |
