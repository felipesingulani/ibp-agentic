# Decision-Ready Scenario Pack — gaps de negócio Domain Rewire · IBP (design/spec)

**Data:** 2026-10-31 · **Autor:** PO Agentic (Grok Bot) para **Felipe** (Domain Owner / PO)
**Base:** tour em tela de `https://ibp-agentic.vercel.app` (UI wire **v0.3.10**, banner `?live=1`) + leitura de código (`src/w3/*`, `src/a4/*`, `docs/architecture/*`).
**Status:** CRAVADO por Felipe 2026-10-31 ~21:43 BRT — Approach B + ordem §10.
**Pré-requisito duro:** `T-A4-SOLVER-WORKER` **GREEN** (contrato `docs/architecture/A4-SOLVER-WORKER-CONTRACT.md`).

---

## 0. TL;DR (provocação)

O produto **promete IBP** (Sales + Supply + Finance decidindo juntos), mas hoje **entrega um cockpit de exceções com uma régua de alçada**. O CFO entra, vê `Capital de giro: não calculado na V0`, vê R$ 3,4 mi contra um limite de R$ 2 mi — e **não tem como dizer sim**, porque ninguém mostrou quanto o cenário devolve. Supply vê o gap de capacidade do CD3, mas o plano A4 não diz **o que produzir, comprar ou transferir, quando**. Resultado: a demo convence o analista e **perde o comprador**.

**Aposta:** fechar o loop **em UM cenário** (expansão Ribeirão) — ΔWC + margem/payback + plano operável + gates de cadastro + comparação lado a lado. Isso é o **Decision-Ready Scenario Pack**: o primeiro momento em que a Finance pode aprovar com número, e não por fé.

---

## 1. Problema / por que agora

### 1.1 O que o tour mostrou (demo-ready, manter)
- Pulse = plano vigente + exceções + decisões + execução; **cockpit de exceções** funciona.
- **Alçada Finance fail-closed**: cenário com R$ 3,4 mi vs limite R$ 2 mi → `pending_finance`. Correto.
- **Cenário stale** vs cadastro v40/v41 detectado (approve bloqueia com 409).
- Wizard: **ditado → 4 premissas** + **capacity gap CD3** + barras de utilização.
- `?live=1` liga Pulse/Cadastro; Journey/Execução/Cenários seguem mock.

### 1.2 Gaps de negócio (ranqueados por quem trava a venda)
| # | Gap | Quem trava | Severidade |
|---|---|---|---|
| 1 | **Capital de giro vazio** (`wc` = `not_computed_v0`) | CFO | Bloqueia aprovação |
| 2 | **Sem P&L/margem/payback/NPV** — alçada é só um limite nu | CFO | Bloqueia aprovação |
| 3 | **Sem motor de forecast de vendas** — só histórico dos 3 últimos períodos | Sales/Diretor comercial | Alto |
| 4 | **Curva A1 é ferramenta de demo** — sem sazonalidade explícita, promo/preço, P10/P90, real vs plano, canibalização de receita | Sales | Alto |
| 5 | **Filtros nó/família "em breve"** — nenhum dono enxerga a sua fatia | Todos os donos | Alto (gestão à vista) |
| 6 | **Supply sem estoque/lead time/serviço por SKU-nó**; políticas 18d / OTIF 95% / DSI 45 não cruzam com o plano | Supply | Alto |
| 7 | **Plano A4 não operável** — sem linhas período × movimentação (produzir/comprar/transferir), sem sobra/falta mensal de capacidade, sem quebra de custo, e mostra "0 restrições" com 3 contratos vigentes | Supply/Planejamento | Bloqueia execução |
| 8 | **Cenário não vira tese de decisão** — sem comparação lado a lado; A4/Takeaways não aparecem no fluxo; conviction pack mock | Domain Owner/Board | Alto |
| 9 | **Cadastro incompleto não bloqueia expansão** — FIL-RAO sem capacidade, CT-104 sem volume/vigência, FD-06 warn, apesar de "100% mínimo" | Domain Owner | Credibilidade |
| 10 | **Journey + Execução mock/vazios** — o ciclo plano→real não fecha | Todos | Médio (V1) |
| 11 | **Governança rasa** — sem delegação, SLA, histórico de "por quê" da aprovação; cadastro stale sem dono | Finance/Auditoria | Médio |
| 12 | **Export só JSON/CSV; números de demo inconsistentes** (36 meses / 14 filiais / 1.240 SKUs no discurso vs 4 SKUs / 5 nós no dado) | Comprador | Credibilidade |

### 1.3 Por que agora
- O A4 worker (Path A) está saindo → pela primeira vez o solver roda em prod. **Rodar o solver sem mostrar o plano e o dinheiro é desperdiçar a entrega.**
- O próximo passo da fila (A7.enabled no tenant demo) **orquestra uma decisão que a Finance ainda não consegue tomar**. Ligar A7 antes deste pack = automatizar um "escalar para humano" eterno.

### 1.4 KPI de land-and-expand
- **North-star da demo:** *"CFO + Supply aprovam (ou rejeitam com motivo) o cenário de expansão em ≤ 15 min, na mesma tela, sem planilha paralela."*
- KPIs de apoio (medidos no tenant demo e em pilotos):
  - % de cenários com Investimento que chegam à Finance com **ΔWC + margem + payback calculados** → meta **100%**.
  - Tempo `pending_finance → approve|escalate` → meta **< 1 dia útil** no piloto.
  - % de decisões com `why` referenciando número do pack (não texto livre) → meta **≥ 80%**.
  - Expansão (expand): nº de **donos de domínio ativos por tenant** (Sales/Supply/Finance com ≥1 ação/semana) → meta **3/3** no piloto.

---

## 2. Personas & jobs-to-be-done

| Persona | Job principal ("quando… quero… para…") | O que precisa ver no pack |
|---|---|---|
| **Sales (Diretor Comercial / Demand Planner)** | Quando proponho abrir Ribeirão, quero mostrar a receita incremental e o risco de canibalização, para ganhar o investimento. | Receita baseline vs expansão por família/nó; premissas de volume com fonte; filtro nó/família. |
| **Supply (Planejamento / Logística)** | Quando o cenário é aprovado, quero saber o que produzir/comprar/transferir por período e onde falta capacidade, para executar sem improviso. | Tabela de plano período × movimentação; sobra/falta de capacidade por nó; restrições ativas (contratos/capacidade); serviço vs política (OTIF 95%, 18d). |
| **Finance (Controller / CFO — alçada)** | Quando um cenário passa do meu limite, quero ver quanto capital ele prende e quando ele se paga, para aprovar com número e não por fé. | ΔWC, Δmargem de contribuição, capex, payback simples, fonte de cada driver, status de alçada e frescor do cadastro. |
| **Domain Owner (Felipe)** | Quero que cadastro incompleto **impeça** um cenário de chegar à decisão, para a ferramenta nunca vender número podre. | Gates de cadastro com bloqueio/aviso e CTA para corrigir. |

---

## 3. Abordagens

### A — Completude S&OP ampla
Forecast + WC + linhas de plano + filtros + governança, para todos os cenários e nós.
- ✅ Fecha vários gaps de uma vez; discurso "IBP completo".
- ❌ Largo demais para um Go; mistura motor estatístico (forecast) com contabilidade (WC) e UI de plano; risco alto de sair tudo a 60%.
- ❌ Atrasa a primeira aprovação com número em ≥ 3 semanas.

### B — Finance + Supply fecham o loop em UM cenário de expansão ✅ **RECOMENDADA**
Para o cenário **Expansão Ribeirão** (e o baseline): ΔWC v0 + stub de margem/payback + linhas do plano A4 por período + gap de capacidade acionável + gates de cadastro antes do **Avaliar** + faixa de comparação 2 cenários.
- ✅ Destrava exatamente quem trava a venda (CFO) e quem executa (Supply), **numa única demo**.
- ✅ Reusa o que já existe: premissas, alçada fail-closed, A4 worker, snapshot W3 (regra de "um número, uma fonte").
- ✅ Prepara o terreno para A7.enabled: o veredito `auto_policy` passa a ter dado para decidir.
- ❌ Forecast continua histórico simples (gaps #3/#4 ficam explicitamente parqueados).
- ❌ Fórmulas simplificadas (WC por dias, sem fluxo de caixa mensal) — **aceito e rotulado** na UI.

### C — Motor de forecast de vendas primeiro
- ✅ Sales ganha credibilidade; base para P10/P90.
- ❌ Não destrava a alçada: o CFO continua sem WC/margem → cenário continua parado em `pending_finance`.
- ❌ Maior risco técnico (dados, sazonalidade, validação vs real) sem dado real de cliente.

**Decisão PO:** **B**. A e C entram como roadmap (§6 e §11).

---

## 4. Jornadas do Decision-Ready Pack

### J1 — Domain Owner prepara o cenário (gate de cadastro)
1. Abre **Cenários → Expansão Ribeirão**.
2. O pack roda os **gates de cadastro** do escopo do cenário (nós/contratos/SKUs tocados pelas premissas).
3. FIL-RAO sem capacidade → **bloqueio**: botão **Avaliar** desabilitado com motivo "FIL-RAO sem capacidade cadastrada" + CTA **Corrigir no Cadastro** (deep-link para o nó).
4. CT-104 sem volume/vigência → **bloqueio** idem.
5. FD-06 warn → **aviso**: Avaliar habilitado, mas a decisão exigirá `why` ≥ 20 caracteres citando o aviso.
6. Corrige → nova versão do cadastro (v41→v42) → cenário vira **stale** → **Reavaliar** (comportamento existente).

### J2 — Supply avalia o plano
1. **Avaliar** → `POST /api/a4-runs` (worker) → run `feasible|optimal|partial`.
2. Aba **Plano**: tabela período × movimentação (produzir / comprar / transferir / expedir) por nó origem→destino e SKU, com quantidade e custo.
3. Bloco **Capacidade**: por nó e período, capacidade × uso × **sobra/falta** (CD3 aparece em vermelho com a falta em unidades e %).
4. Bloco **Restrições ativas**: lista de contratos e capacidades efetivamente modelados (ex.: 3 contratos vigentes → "3 restrições de contrato"), nunca "0" quando o cadastro tem contratos vigentes.
5. Serviço do plano vs política (OTIF 95%, lead time 18d, DSI 45) com semáforo.

### J3 — Finance decide
1. Fila de alçada → cenário `pending_finance` (R$ 3,4 mi > R$ 2 mi).
2. Abre a **faixa de comparação** Baseline × Expansão: Receita, Margem de contribuição, ΔWC, Capex, Payback, Serviço, Utilização máx., Falta de capacidade, Frescor do cadastro.
3. Cada número tem **ⓘ fonte** (premissa, cadastro vN, run A4, default do pack).
4. **Aprovar** (why obrigatório, pré-preenchido com os 3 números-chave para editar) ou **Escalar** ao Domain Owner.
5. Decision event grava `scenario_version`, `run_id` e snapshot dos números do pack (no `audit_log.payload`, sem migration).

### J4 — Qualquer dono acompanha a sua fatia
1. Em **Pulse** e **Visões (Sales/Supply/Finance)**, filtros **Nó** e **Família** (antes "em breve") funcionam para o set demo de 5 nós.
2. KPIs, exceções e alçada recalculam para o recorte; URL guarda o filtro (`?node=CD3&family=…`) para compartilhar.

---

## 5. Requisitos funcionais

### 5.1 T-BIZ-WC-V0 — Capital de giro calculável
**MUST**
- WC v0 por cenário (baseline e expansão), por período do plano, método **dias de ciclo**:
  - `Receita_p = Σ_sku,nó (volume_p × preço_unit)`
  - `CPV_p = Σ_sku,nó (volume_p × custo_unit)`
  - `Estoque_p = (CPV_p / dias_período) × DSI`
  - `CR_p (contas a receber) = (Receita_p / dias_período) × DSO`
  - `CP_p (contas a pagar) = (CPV_p / dias_período) × DPO`
  - `WC_p = Estoque_p + CR_p − CP_p` · `ΔWC = WC_expansão − WC_baseline` (no último período e pico).
- Drivers e precedência (fonte rotulada): **DSI** ← política `inventory` vigente (demo: 45d); **DSO/DPO** ← política `working_capital` vigente; se ausente → default do pack (`DSO=45`, `DPO=30`) com fonte `default_pack` e chip "default" na UI.
- `preço_unit`/`custo_unit` ← premissa do cenário; senão atributo do SKU no cadastro; senão **`null` com `nullReason="no_price"`/`"no_cost"`** — **nunca zero silencioso**.
- O KPI `wc` do snapshot W3 deixa de ser `not_computed_v0` quando há run A4 válido; mantém `no_plan` sem run.
- Unidade: moeda do tenant (`tenant_settings.currency`), em **mi** com 2 casas.

**SHOULD**
- Quebra do ΔWC em Estoque / CR / CP (barra empilhada).

### 5.2 T-BIZ-MARGIN-STUB — Margem/contribuição e payback
**MUST**
- `MC_p = Receita_p − CPV_p − CustoLogístico_p`, onde `CustoLogístico_p` = custo do plano A4 (objetivo/quebra do run) alocado ao período.
- `ΔMC = MC_expansão − MC_baseline` por período e acumulado.
- `Capex` = soma `impactMi` dos cards **Investimento** (mesma regra de `scenarioImpact` — fonte única com a alçada).
- **Payback simples (meses)** = `Capex / ΔMC_mensal_médio`; se `ΔMC ≤ 0` → `"não se paga no horizonte"` (texto, não número negativo).
- Horizonte = períodos do plano; se horizonte < payback → mostrar "> horizonte (N meses)".

**SHOULD**
- ΔWC entra no payback como **variante "payback com giro"** = `(Capex + ΔWC) / ΔMC_mensal_médio`, exibida ao lado.

**WON'T (V0)**: NPV/TIR, impostos, depreciação, financiamento.

### 5.3 T-BIZ-FILTERS-LENS — Filtros nó/família reais
**MUST**
- `GET /api/pulse/summary`, `GET /api/pulse/exceptions`, `GET /api/visoes/:lens` aceitam `?node=<stable_id|code>` e `?family=<family>` (combináveis, multi-valor por vírgula).
- Filtro aplicado **no snapshot** (uma regra para todos os consumidores); KPIs não filtráveis (ex.: alçada é por cenário) mostram chip "não filtrável" em vez de número errado.
- UI: remove "em breve"; dropdowns populados do cadastro corrente (5 nós demo; famílias distintas dos SKUs).
- Estado do filtro na URL e preservado entre Pulse ↔ Visões.
- Filtro sem resultado → empty state "Nenhum dado para CD3 · Família X" + limpar filtro.

### 5.4 T-BIZ-A4-PLAN-UI — Plano operável
**MUST**
- Aba **Plano** do run: tabela `período × movimentação` com colunas `período · tipo (produzir|comprar|transferir|expedir) · origem · destino · SKU · qtd · uom · custo`.
- Totais por período e por tipo; ordenação e filtro por nó/família (reusa 5.3).
- Bloco **Capacidade** por nó × período: `capacidade · uso · sobra/falta · %` com destaque para falta.
- Bloco **Restrições ativas**: lista nominal de contratos/capacidades/políticas que viraram restrição no modelo, com contagem coerente com o cadastro vigente.
- Quebra de custo do objetivo (produção / compra / frete / penalidade de não-atendimento) quando o run expõe; senão linha única "custo total" com `nullReason`.
- A4 piloto é **1 período** (contrato A4 veta multi-período); a UI renderiza **N períodos que o run devolver** — com 1 período mostra 1 coluna rotulada, sem fingir horizonte.

### 5.5 T-BIZ-CAD-GATES — Gates de cadastro para expansão
**MUST**
- Gate roda **antes** de habilitar **Avaliar** e no `POST /api/a4-runs` (servidor é a verdade; UI só espelha).
- Regras de **bloqueio** (escopo = entidades tocadas pelas premissas do cenário):
  - Nó sem capacidade vigente (ex.: FIL-RAO).
  - Contrato sem volume **ou** sem vigência cobrindo o horizonte (ex.: CT-104).
  - SKU sem custo unitário quando a premissa não traz custo (afeta 5.1/5.2).
- Regras de **aviso** (permitem avaliar; exigem `why` ≥ 20 chars na decisão): data quality warn existente (ex.: FD-06).
- Resposta de bloqueio: `409 { error: { code: "cadastro_gate_block", items: [{ entity, stable_id, rule, cta }] } }`.
- O selo "100% mínimo" do cadastro passa a ser **por escopo do cenário**: "Mínimo global 100% · Expansão Ribeirão: 2 bloqueios".

### 5.6 T-BIZ-COMPARE-STRIP — Comparação lado a lado
**MUST**
- Faixa fixa no topo do cenário e na fila de alçada: **Baseline × Expansão Ribeirão** com: Receita · MC · ΔMC · Capex · ΔWC · Payback (simples e com giro) · Serviço (OTIF) vs política · Utilização máx. · Falta de capacidade · Status de alçada · Versão do cadastro / stale.
- Delta com sinal e cor semântica (verde = melhor para o negócio, não "maior").
- Cada célula: tooltip de fonte; `null` mostra o `nullReason` em português (mapa existente em `journey/conviction.ts`).
- Baseline = cenário marcado como plano vigente; se não houver → empty state "Defina o plano vigente para comparar".

**SHOULD**
- Botão "Copiar resumo para a decisão" que pré-preenche o `why`.

### 5.7 Transversal
- **MUST** coerência de números de demo: o discurso da landing/onboarding usa o mesmo set do dado (5 nós / 4 SKUs / horizonte do run). Remover "36 meses / 14 filiais / 1.240 SKUs" ou rotular como "exemplo de cliente".
- **MUST** regra "um número, uma fonte": ΔWC/MC/payback calculados em um módulo único (ex.: `src/w3/finance.ts`) e consumidos por Pulse, Visões Finance, compare strip, alçada e A7.
- **MUST** sem migration nova (cálculo on-read a partir de `a4_runs.plan` + premissas + cadastro + políticas; snapshot na decisão vai em `audit_log.payload`).

---

## 6. Non-goals (parqueados com dono)

| Item | Por quê fora | Dono parqueado |
|---|---|---|
| Motor de forecast completo (sazonalidade, promo/preço, canibalização) | Abordagem C; não destrava alçada | Felipe (PO) → épico `T-BIZ-FORECAST` pós-pack |
| P10/P90 / bandas de incerteza | Depende do forecast | Deivid (arch) |
| Conectores ERP (leitura/escrita) | Sem cliente piloto definido | Deivid |
| Journey / Execução live | Ciclo plano→real é V1 | Devi (eng) após A7 |
| Takeaways LLM / narrativa | A7 é `state_machine_only` | Deivid |
| Deck S&OP em PDF | JSON/CSV atende piloto | Didi (UX) |
| NPV/TIR, impostos, financiamento | Stub de payback basta para alçada V0 | Felipe |
| A4 multi-período / Gurobi | Anti-goal do contrato A4 | Deivid |
| Delegação/SLA de alçada | Governança V1 | Felipe |

---

## 7. Critérios de aceite (linguagem de negócio)

1. **CFO aprova com número:** no tenant demo, a fila de alçada mostra a Expansão Ribeirão com Capex R$ 3,4 mi, ΔWC, ΔMC e payback preenchidos; nenhum aparece como "não calculado na V0" quando existe run A4 válido.
2. **Nada de número inventado:** se falta preço ou custo, a tela diz **qual** dado falta e onde corrigir — nunca mostra zero.
3. **Supply sabe o que fazer:** a aba Plano lista, por período, o que produzir/comprar/transferir, de onde para onde, quanto e a que custo; o CD3 aparece com a falta de capacidade em unidades.
4. **Restrições batem com o cadastro:** com 3 contratos vigentes no escopo, o plano mostra 3 restrições de contrato — nunca "0 restrições".
5. **Cadastro ruim não vira decisão:** com FIL-RAO sem capacidade ou CT-104 sem vigência, o botão Avaliar fica bloqueado com o motivo e o atalho de correção; a API também recusa.
6. **Aviso não é bloqueio:** com FD-06 em warn, dá para avaliar, mas a decisão exige justificativa.
7. **Comparação em uma tela:** Baseline × Expansão lado a lado com os 11 indicadores do §5.6, cada um com fonte.
8. **Cada dono vê a sua fatia:** filtrar Pulse por CD3 e por família muda KPIs e exceções; o link com filtro abre igual em outra aba.
9. **Demo coerente:** nenhum número do discurso contradiz o dado exibido.
10. **Rastro de auditoria:** a decisão grava versão do cenário, run e os números do pack usados.

---

## 8. Matriz de testes por dono

### 8.1 Didi — UI/UX acceptance (telas)
| ID | Tela | Cenário | Esperado |
|---|---|---|---|
| UX-01 | Visões Finance | Run A4 válido da Expansão | Card WC mostra valor em `R$ mi`, chip de fonte; sem "não calculado na V0" |
| UX-02 | Visões Finance | Sem run (baseline sem plano) | Empty state "sem plano — rode o A4" + CTA Avaliar |
| UX-03 | Visões Finance | SKU sem custo | Card mostra "falta custo unitário de SKU-X" + link Cadastro; nenhum `0` |
| UX-04 | Compare strip | Baseline + Expansão | 11 indicadores, deltas com sinal e cor semântica; tooltip de fonte em todas as células |
| UX-05 | Compare strip | Sem plano vigente | Empty state "Defina o plano vigente para comparar" |
| UX-06 | Compare strip | ΔMC ≤ 0 | Payback = "não se paga no horizonte" (texto) |
| UX-07 | Plano | Run feasible | Tabela período × movimentação com totais; ordenação por qtd e custo |
| UX-08 | Plano | Run 1 período | 1 coluna rotulada com a data; nenhum período fake |
| UX-09 | Plano / Capacidade | CD3 em falta | Linha CD3 em destaque, falta em unidades e % |
| UX-10 | Plano / Restrições | 3 contratos vigentes | "3 restrições de contrato" com nomes clicáveis |
| UX-11 | Cenário | FIL-RAO sem capacidade | Avaliar desabilitado; motivo + CTA "Corrigir no Cadastro" com deep-link |
| UX-12 | Cenário | FD-06 warn | Avaliar habilitado; banner de aviso; modal de decisão exige why ≥ 20 |
| UX-13 | Pulse | Filtro nó=CD3 | KPIs/exceções recalculam; URL `?node=CD3`; "em breve" removido |
| UX-14 | Pulse → Visões | Filtro persistente | Navegar mantém nó/família |
| UX-15 | Pulse | Filtro sem dados | Empty state com "Limpar filtro" |
| UX-16 | Alçada | KPI não filtrável | Chip "não filtrável" em vez de número |
| UX-17 | Decisão | Copiar resumo | `why` pré-preenchido com Capex/ΔWC/payback, editável |
| UX-18 | Onboarding/landing | Números do discurso | Coerentes com 5 nós / 4 SKUs ou rotulados "exemplo" |
| UX-19 | Geral | `?live=1` | Banner continua indicando o que é live vs mock (Journey/Execução mock) |

### 8.2 Deivid — contratos de arquitetura
| ID | Contrato | Verificação |
|---|---|---|
| AR-01 | `contracts/scenario-finance.schema.json` (novo) | Campos: `revenue`, `cogs`, `logisticsCost`, `mc`, `deltaMc`, `capexMi`, `wc{inventory,receivables,payables,total}`, `deltaWc`, `paybackMonths`, `paybackWithWcMonths`, `drivers[{key,value,source}]`, `nullReason` por campo |
| AR-02 | Fórmulas §5.1/§5.2 | Documento de fórmula versionado (`formula_version: "wc_days_v0"`, `"mc_stub_v0"`) retornado na API |
| AR-03 | Precedência de drivers | premissa > cadastro > política vigente > `default_pack`; fonte sempre exposta |
| AR-04 | Fonte única | `scenarioImpact` (alçada) e `capexMi` (pack) saem da mesma função; teste de igualdade |
| AR-05 | Filtros | Contrato de query `node`/`family` para `/api/pulse/summary`, `/api/pulse/exceptions`, `/api/visoes/:lens`; filtro aplicado no snapshot W3; lista de KPIs `filterable:false` |
| AR-06 | Plan lines | Shape `plan.lines[{period, kind, from, to, sku, qty, uom, cost}]` + `plan.capacity[{node, period, cap, used, gap}]` + `plan.activeConstraints[{kind, ref, name}]` em `a4-run-summary.schema.json` (bump minor, retrocompatível) |
| AR-07 | Gates | `409 cadastro_gate_block` com `items[]`; regras block/warn documentadas; mesmo avaliador no UI-hint e no POST |
| AR-08 | Sem migration | Cálculo on-read; snapshot do pack em `audit_log.payload` no decision event |
| AR-09 | RLS | Nenhuma porta cross-tenant nova; filtros respeitam FORCE RLS |
| AR-10 | Env | Nenhuma env nova além de `A4_SOLVER_URL`/`A4_SOLVER_SECRET`; defaults `DSO=45`/`DPO=30` no pack config, não em env |
| AR-11 | A7 | `POST /api/a7/evaluate` passa a ler o pack finance; `auto_policy` só se ΔMC > 0 **e** capex ≤ alçada **e** zero gate block |

### 8.3 Devi — eng / implementação
| ID | Tipo | Teste | Prova |
|---|---|---|---|
| EN-01 | unit | WC com fixture (volume, preço, custo, DSI 45, DSO 45, DPO 30, período 30d) bate o valor calculado à mão | `npm test` |
| EN-02 | unit | Preço ausente → `wc=null`, `nullReason="no_price"`; nunca 0 | `npm test` |
| EN-03 | unit | ΔMC ≤ 0 → `paybackMonths=null` + `nullReason="no_payback_in_horizon"` | `npm test` |
| EN-04 | unit | `capexMi` == `scenarioImpact().impactMi` (3,4 no fixture) | `npm test` |
| EN-05 | unit | Precedência de drivers (4 combinações) | `npm test` |
| EN-06 | integration | `GET /api/visoes/finance` com run válido → `wc.value != null`, `reason != not_computed_v0` | curl |
| EN-07 | integration | `GET /api/pulse/summary?node=CD3` ≠ sem filtro; `?node=XYZ` → 200 vazio (não 500) | curl |
| EN-08 | integration | `?family=A,B` multi-valor | curl |
| EN-09 | integration | `POST /api/a4-runs` com FIL-RAO sem capacidade → 409 `cadastro_gate_block` com item `FIL-RAO` | curl |
| EN-10 | integration | CT-104 sem vigência → 409; com warn FD-06 → 202 | curl |
| EN-11 | integration | `GET /api/a4-runs/:id` → `plan.lines.length>0`, `activeConstraints` contém os 3 contratos vigentes | curl |
| EN-12 | integration | Decision event approve grava `audit_log.payload.pack` com ΔWC/ΔMC/payback | `npm test` |
| EN-13 | regressão | A1, A7 evaluate, alçada fail-closed, stale 409, export | `npm test` green |
| EN-14 | prod smoke | Tenant demo: compare strip API retorna baseline+expansão completos | curl prod |

**Exemplos de curl (prova):**
```bash
curl -s "$BASE/api/visoes/finance" -H "$AUTH" | jq '.cards[] | select(.key=="wc")'
curl -s "$BASE/api/pulse/summary?node=CD3&family=A" -H "$AUTH" | jq '.kpis'
curl -s -X POST "$BASE/api/a4-runs" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"scenarioId":"<expansao-ribeirao>"}' | jq '.error.code, .error.items'
curl -s "$BASE/api/a4-runs/<runId>" -H "$AUTH" | jq '.plan.lines[0], .plan.activeConstraints'
```

---

## 9. Tasks sugeridas

| ID | Escopo | Eng | Arch | UX | Tamanho |
|---|---|---|---|---|---|
| **T-BIZ-CAD-GATES** | §5.5 gates block/warn + 409 | Devi | Deivid (regras) | Didi (estado Avaliar) | ~1d |
| **T-BIZ-WC-V0** | §5.1 WC dias de ciclo + KPI `wc` live | Devi | Deivid (schema/fórmula) | Didi (card) | ~1,5d |
| **T-BIZ-MARGIN-STUB** | §5.2 MC/ΔMC/payback | Devi | Deivid | Didi | ~1d |
| **T-BIZ-A4-PLAN-UI** | §5.4 plan lines + capacidade + restrições | Devi (shape no summary) | Deivid (schema bump) | Didi (aba Plano) | ~2d |
| **T-BIZ-COMPARE-STRIP** | §5.6 faixa baseline × expansão | Devi (endpoint agregador) | Deivid | Didi | ~1,5d |
| **T-BIZ-FILTERS-LENS** | §5.3 filtros nó/família | Devi | Deivid (query contract) | Didi | ~1,5d |

QA de aceite por task: **Qualidade** com checklist `QA-ACCEPTANCE-T-BIZ-*.md` derivado do §7/§8.

---

## 10. Dependências e ordem

1. **T-A4-SOLVER-WORKER GREEN** (Devi eng → Deivid publish envs → Qualidade prod). Sem isso não há plano real.
2. **Contrato arch do pack** (Deivid, 1-pager: AR-01..AR-11) — antes de abrir eng.
3. **T-BIZ-CAD-GATES** (garante que só dado bom entra) →
4. **T-BIZ-WC-V0** + **T-BIZ-MARGIN-STUB** (mesmo módulo; podem ir juntos) →
5. **T-BIZ-A4-PLAN-UI** (depende do shape do summary) →
6. **T-BIZ-COMPARE-STRIP** (consome 4 e 5) →
7. **T-BIZ-FILTERS-LENS** (paralelizável a partir do passo 3; não bloqueia a demo de decisão).
8. **Depois do pack:** override **`A7.enabled`** no tenant demo — agora com dado para `auto_policy`.

---

## 11. Riscos e perguntas em aberto (com default decidido)

| Risco / pergunta | Default decidido | Reabre se… |
|---|---|---|
| Tenant demo não tem preço/custo por SKU | Seed de preço/custo para os 4 SKUs no cadastro demo (via write de cadastro existente, sem migration) | Felipe preferir premissa por cenário |
| DSO/DPO não existem como política | Default do pack `DSO=45`, `DPO=30`, rotulado "default" | Cliente piloto trouxer os seus |
| A4 piloto é 1 período → payback sobre 1 período é frágil | Mensaliza o período e projeta linear no horizonte declarado do cenário, rotulado "projeção linear v0" | A4 multi-período entrar |
| Custo logístico do objetivo não vem quebrado | Linha única "custo total do plano" + `nullReason` na quebra | Worker expor quebra |
| "Baseline" ambíguo | Baseline = plano vigente (run aprovado mais recente não-stale) | — |
| Gates podem bloquear a demo atual | Ordem do roteiro de demo: mostrar o bloqueio (é argumento de venda), corrigir FIL-RAO/CT-104 ao vivo, reavaliar | — |
| Escopo cresce para "todos os cenários" | Pack calcula para qualquer cenário, mas aceite e demo só exigem Expansão Ribeirão + baseline | — |
| Números do discurso inconsistentes | Trocar para o set real do demo agora (UX-18) | — |

**Pergunta única ao Felipe:** cravar **Abordagem B** e a ordem do §10? (Default se silêncio: B, ordem do §10.)
