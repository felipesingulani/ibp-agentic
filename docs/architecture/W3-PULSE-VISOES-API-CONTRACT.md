# Task 8 — W3 Pulse/Caixa + Visões API (contrato arquitetura)

Status: **aprovado Deivid** · PO cravou planRef + vocab · eng Task 8 (2026-10-30) · 2026-10-30 · wire alvo: shell **v0.3.4** + wizard **v0.2.3** (Didi, alçada B) · implementação: Devi (depois da Task 7)

## Objetivo V0
Dar **read paths** para as superfícies §11.2 (Pulse/Caixa) e §11.3 (Visões por lente) do put spec, mais a **fila de alçada Finance thin** do wire (B). Tudo **leitura** sobre o que já está no banco (cadastro, cenários, cartões, runs A4, decision events). **Nenhum KPI inventado**: se o dado não existe, o valor é `null` + motivo, e a UI mostra `—` + checklist/próximo passo (wire v0.3.1 PO(3) / v0.3.2 C4).

Sem LLM, sem solver novo, sem escrita (a única escrita da fila — aprovar/escalar — já é o `POST` de DecisionEvent da Task 7).

## Pré-requisitos
- **Task 6** (W2) green: `scenarios` SELECT/INSERT/UPDATE (0011), premise cards, ditado mock.
- **Task 7** (W2b) green: `decision_events` gravável (0012: SELECT/INSERT, append-only, FKs compostas por tenant, FORCE RLS) + A7 stub. W3 **só lê** `decision_events`.
- W1c: `a4_runs` com `plan.totals` (`demand/served/unmet/fillRate`), `plan.objective`, `plan.utilization`, `reasons` (≤3) e `counts_by_kind`.
- Readiness (`GET /api/a4-readiness`) e `tenant_settings` (`kpi_labels`, `currency`, `uom`, `confirmed_at`).
- **Grants: nenhum novo.** App já tem SELECT em todas as tabelas lidas (0004 cadastro, 0007 `premise_cards`, 0009 `a4_runs`/`scenarios`, 0012 `decision_events`). Se a implementação pedir grant novo, é sinal de escopo errado → volta pro Deivid.
- **Migrations: nenhuma.** Fila de alçada = projeção (view lógica em código/SQL de leitura), não tabela.

## Conceitos (mesma verdade para Pulse e Visões)

### `planRef` — qual plano os números descrevem
Todo payload de Pulse e Visões carrega o **mesmo** `planRef`, resolvido uma vez por request:

| `basis` | Regra | UI |
|---|---|---|
| `approved` | Último `decision_events` com `action=approve` cujo `run_id` aponta para run `feasible\|partial` **da mesma** `scenario_version`, e essa versão ainda é a corrente do cenário | “Plano vigente: <cenário> vN · run …” |
| `latest_run` | Sem aprovação válida → último run `feasible\|partial` de um cenário corrente não arquivado | Tag “não aprovado” (**cravado PO**) |
| `none` | Nenhum run done | “Sem plano vigente · nenhum run do A4” → KPIs `null` |

`planRef = { basis, scenarioId|null, scenarioVersion|null, runId|null, at|null }`. Trocar de lente **não** muda `planRef` nem números (§11.3 “mesma verdade, lentes diferentes”).

### KPI tipado
```json
{ "key": "svc", "label": "OTIF", "value": 0.956, "unit": "ratio", "nullReason": null, "source": "a4_run.plan.totals.fillRate" }
```
- `key` no **Pulse summary** ∈ `wc | svc | cost | viol` (`wcp` só rótulo). `label` = `kpi_labels[key]` ou default do pack/UI.
- **Visões** (`cards`/`cross`): keys **podem** sair do enum do board. **Canônicas (API):** `demand_3p | util_avg | util_max | network_gaps | contracts_current | invest_mi | nodes_current | scenarios_sales | volume_premises | adherence`. **Aliases só na lookup de label** (wire/legado → canônica): `gaps_net→network_gaps`, `nodes_n→nodes_current`, `contracts_n→contracts_current`, `scenarios_n|scn_sales→scenarios_sales`, `inv_mi→invest_mi`. **Regra:** `label` string não vazia obrigatória; precedência `tenant_settings.kpi_labels` → pack → default PT. Defaults PT oficiais: `volume_premises` = "Premissas de volume (curvas de demanda)"; `adherence` = "Aderência ao plano (execução)". Key fora do catálogo → omitir (não 400). Pulse board: `wc|svc|cost|viol`.
- `value: number|null`. Se `null`, `nullReason` ∈ `no_plan | no_data | not_computed_v0` (enum de API, não de `contracts/`).
- `source` = de onde o número saiu (string informativa, para Qualidade conferir). **Proibido** valor sem `source`.
- Sem `delta`/sparkline na V0 (exige série histórica de planos aprovados → W4). Campo `trend` **não** existe na V0.

| KPI | Fonte V0 | `null` quando |
|---|---|---|
| `svc` (serviço) | `plan.totals.fillRate` do run do `planRef` (proxy de fill, 1 período — o A4 piloto não mede OTIF real) | `basis=none` → `no_plan`; `fillRate=null` (demanda 0) → `no_data` |
| `cost` (custo por unidade) | `plan.objective / plan.totals.served`, `unit = "<currency>/<uom>"` | `no_plan`; `served=0` → `no_data` |
| `viol` (violações/exceções) | contagem de `GET /api/pulse/exceptions` por severidade (`block`, `warn`) — mesmo cálculo, mesma request | nunca `null` se readiness existe (0 é número real); tenant sem nada → `0` **só** se a contagem for de fato vazia |
| `wc` (capital de giro) | **não calculado na V0**: A4 é 1 período, 1 escalão, sem estoque; `finance_drivers` não tem motor | sempre `not_computed_v0` (UI: `—` + “entra com o A4 multi-período”) |

## Endpoints (tenant via `x-tenant-id` + RLS; `x-user-id` opcional, stub)
| Método | Path | Notas |
|--------|------|--------|
| `GET` | `/api/pulse/summary` | `{ planRef, kpis: Kpi[4], readiness: {state, met, need, items[]}, unlock: {newScenario}, pending: {alcada: n, staleScenarios: n}, empty: bool, nextStep }`. `empty=true` quando `basis=none` → KPIs `null` + checklist da prontidão + `nextStep` (mesma lógica do coach v0.3.2: config → política → nó c/ capacidade → rota → contrato se supply externo → Novo cenário). |
| `GET` | `/api/pulse/exceptions` | **A6 read stub** (sem agente, sem LLM): lista derivada e deduplicada, ordenada `block > warn > info`. Query `?severity=block\|warn\|info` opcional. Ver fontes abaixo. |
| `GET` | `/api/alcada/queue` | `AlcadaQueueItem[]` (`contracts/alcada-queue-item.schema.json`). Query `?status=pending_finance\|approved_finance\|escalated_owner\|stale` opcional; default = todos, abertos primeiro. Resposta inclui `policy: {id, version, alcadaMi} \| null` e `mode` (ver Regras/alçada). |
| `GET` | `/api/visoes/:lens` | `lens ∈ sales\|supply\|finance` (subconjunto de `DecisionEvent.actor.role`; outro valor → `400 invalid_lens`). `{ lens, planRef, cards: Kpi[], cross: Kpi[], action: {kind, enabled, disabledReason}, empty, nextStep }`. Filtros nó/família **fora** da V0 (query desconhecida → ignorada, não 400). |

Aprovar/escalar item da fila **não** tem endpoint novo: UI chama o `POST` de DecisionEvent da Task 7 (path que a Devi publicar) com `scenarioId/scenarioVersion/runId`; a fila reflete na próxima leitura.

### `GET /api/pulse/exceptions` — fontes (A6 read stub)
Item: `{ id, source, kind, severity, summary, refs, scenarioId|null, action }` — `kind`/`severity`/`refs` **reusam `a4-reason.schema.json`** (`janela|capacidade|contrato|custo|outro`, `info|warn|block`). `source` (enum de API) ∈:

| `source` | De onde | kind/severity |
|---|---|---|
| `a4_run` | `reasons` do run do `planRef` | como gravado |
| `readiness` | itens `block` da prontidão (falta política/nó c/ capacidade/rota/contrato) e nós sem capacidade (`warn`) | `outro`/`capacidade`, severity da prontidão |
| `premise_gap` | cartões `Gap` abertos (`status=gap`) de cenários correntes | `capacidade`, `warn` (igual readiness) |
| `alcada` | itens `pending_finance` da fila | `custo`, `warn` |

“Programado vs plano” (movimentações reais × plano, §7.5) **não tem fonte na V0** (não há tabela de execução) → fora, W4. A tabela do wire sample (TR-882, PC-551…) é **seed de wire**, não contrato.

`action` = CTA textual tipado (`open_cadastro | open_scenario | rerun_a4 | alcada_queue`), sem prose LLM.

### `GET /api/visoes/:lens` — cards por lente (mesma verdade)
| Lente | `cards` (primário) | `cross` (secundário, sempre presente) | `action` (CTA do wire v0.3.1 PO(4)) |
|---|---|---|---|
| `sales` | demanda últimos 3 períodos (`sales_history.qty`), nós correntes, cenários `leg=sales` por status | `svc` e utilização máx. (Supply) · `pending.alcada` (Finance) | `new_scenario` — `enabled = unlock.newScenario` (mesma regra 0010/Task 6) |
| `supply` | utilização média/máx. (`plan.utilization`), gaps de rede (premise_gap + nós sem capacidade), contratos correntes + razões `kind=contrato` do run | demanda 3 períodos (Sales) · `cost` (Finance) | `register_gap` — reaproveita `POST .../premise_cards` (Gap exige `links.nodeId`) |
| `finance` | `wc` (`not_computed_v0`), investimento em cenários correntes (soma Investimento, mi), decisões pendentes na alçada | premissas de volume (Sales) · `cost` (Supply) | `alcada_queue` — contador = `pending_finance` |

Regra de verdade única: um número que aparece em mais de um lugar (ex.: `cost`, `pending.alcada`, demanda 3 períodos) sai **da mesma função** e do mesmo `planRef` — teste de igualdade entre `/pulse/summary` e as três lentes no DoD. “Forecast” da lente Sales **não existe** na V0 (não há motor de forecast; `CurvaDemanda` é premissa de cenário) → card ausente, não estimado.

## Regras
1. **Empty tenant nunca inventa número.** Sem run → KPIs `value=null` + `nullReason`; contagens só aparecem quando vêm de query real (0 real ≠ `null`). Proibido fallback para seed/sample no backend: sample demo é **dataset de seed** carregado no tenant demo, não ramo de código.
2. **RLS + tenant header** como W1/W2: `x-tenant-id` obrigatório (UUID) → `SET app.tenant_id`; FORCE RLS em todas as tabelas lidas; sem `SECURITY DEFINER`, sem `BYPASSRLS`. Cross-tenant: tenant B nunca vê fila/exceções de A (inclusive `events[]` dentro do item).
3. **Grants mínimos:** só SELECT (já existentes). Endpoints W3 são `GET` puros — nenhum `INSERT/UPDATE` em código W3.
4. **Moeda/unidade só formatam** (`tenant_settings.currency/uom`); sem câmbio. `*Mi` = milhões da moeda do tenant.
5. **Alçada (wire B):**
   - POL de alçada = política corrente com `kind` normalizado em vocabulário provisório `alcada` (mesmo padrão de `POLICY_KINDS`; migra para `tenant_settings.policy_kinds` depois) e limiar numérico em `body.limitMi`.
   - Impacto do cenário = soma de `fields.impactMi` (número, **já em milhões**, agnóstico — pack só muda o *label* Capex/WC/…, não o campo) dos cartões `Investimento` da versão; cartão `Investimento` sem número legível → `impactMi=null`.
   - **Cravado PO + arquitetura = fail-closed** (2026-10-30 Squad: fail-open só se POL-04 fora do pack; no pack sem limiar ≡ misconfigured):
     | Situação | `mode` | Efeito |
     |---|---|---|
     | Sem POL de alçada no pack/cadastro do tenant | `no_policy` (fail-open) | fila vazia + aviso “Sem política de alçada publicada” + CTA criar; Sales aprova |
     | POL de alçada existe **sem** limiar válido | `misconfigured` (fail-closed) | todo cenário com `Investimento` entra como `pending_finance`; Sales não aprova; CTA “corrigir alçada” |
     | Limiar válido | `active` | entra se `impactMi > alcadaMi` **ou** `impactMi=null` (fail-closed) |
   - `status` derivado: decisão `actor.role=finance` na versão → `approved_finance`/`escalated_owner`; versão corrente mais nova → `stale`; senão `pending_finance`. Bloquear aprovação de versão `stale` é regra do `POST` da Task 7 (confirmar com Devi que ela retorna 409); a fila só reporta.
6. **LLM:** zero. Gate W3 = gate W2 + DENY de `fetch(`/LLM em `src/http/pulse*`/`visoes*`/`alcada*`.

## Contratos
- **Novo (rascunho):** `contracts/alcada-queue-item.schema.json` — `additionalProperties:false`; `status` = enum do wire; `escalateTo` ⊂ roles do DecisionEvent; `events[]` = `$ref decision-event.schema.json`. Diferenças vs wire: `nome→name`, `invMi→impactMi` (nome que já combinamos para o evento), `source` do wire fora.
- **Reuso:** `a4-reason.schema.json` (kind/severity/refs das exceções), `decision-event.schema.json` (eventos na fila).
- **DecisionEvent v0.2**: opcionais no schema; persistência = snapshot no `audit_log.payload` jsonb da decisão (append-only, mesma tx) — **sem 0013/colunas**. GET junta via LATERAL. Fila ainda deriva no read; `policyRef` só em `AlcadaQueueItem`.
- KPI/Exception/Visões ficam como shapes de API neste doc (sem schema em `contracts/` na V0); viram schema se o wire/UI precisar validar.

## DoD (Devi / Qualidade)
- [ ] `GET /api/pulse/summary` — tenant vazio: `planRef.basis=none`, 4 KPIs `value=null` com `nullReason`, checklist + `nextStep`; **nenhum número** fora de contagens reais
- [ ] Tenant com run: `svc`/`cost` batem com `a4_runs.plan` do `planRef` (teste compara com cálculo direto); `wc` = `not_computed_v0`
- [ ] `planRef` respeita prioridade `approved > latest_run > none`; aprovação de versão superada não vira plano vigente
- [ ] `GET /api/pulse/exceptions` — 4 fontes, dedupe, ordem por severidade, `kind/severity` válidos contra `a4-reason.schema.json`; `viol` do summary = contagem desta lista
- [ ] `GET /api/alcada/queue` — itens validam contra `alcada-queue-item.schema.json` (ajv no teste); casos: `no_policy` (vazia), `misconfigured` (fail-closed), `active` (> limiar entra, ≤ não entra, `impactMi=null` entra), approve/escalate Finance muda status, nova versão → `stale`
- [ ] `GET /api/visoes/:lens` — 3 lentes + `400 invalid_lens`; números compartilhados idênticos entre lentes e Pulse; CTA `new_scenario` respeita unlock (403/409 já da Task 6)
- [ ] RLS: tenant B não vê nada de A (fila, `events[]`, exceções); sem header → 401
- [ ] Zero migration, zero grant novo, zero LLM/`fetch(` (gate W3 verde); W1/W2 continuam verdes
- [ ] Qualidade: empty tenant (`—` em tudo) · sample · alçada 2/5/none do wire (Cadastro → gate → Pulse) contra API

## Fora
- **W4** execution pulse write path (movimentações programadas × plano, ingestão de execução, A6 como agente)
- **LLM prose A7** (takeaways/narrativa) — continua DENY
- **Write-back** em ERP; export além do que a Task 7 já define
- **Gurobi/CPLEX** e qualquer solver pago
- KPI de capital de giro calculado, deltas/sparklines/tendência, forecast, filtros nó/família
- RBAC real (role vem do header/stub; Finance-only na fila é regra de UI + Task 7)
