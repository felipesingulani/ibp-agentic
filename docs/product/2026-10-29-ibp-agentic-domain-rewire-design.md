# Design Spec: Domain Rewire OS — IBP Agentic (Estoque, Working Capital & S&OP/IBP)

**Date:** 2026-10-29  
**Status:** Draft for review  
**Owner:** PO — Agentic Transformation (com Felipe)  
**Anchors:** McKinsey Rewired 2.0 / AI Transformation Manifesto; wedge em operações industriais & supply  

---

## 1. Problem statement

Empresas industriais e de supply sabem *onde* a IA deveria criar valor (leverage econômico em estoque, serviço e caixa), mas caem no nível do *training*: S&OP/IBP continua em slides e planilhas; o ciclo mensal não conversa com o pulso diário; cenários de vendas, suprimentos e finance não são gerados nem tensionados de forma integrada; políticas (estoque, capacidade, contratos) não entram como restrições de primeira classe num otimizador; e ninguém fecha o loop insight → decisão → ação com accountability de P&L/balanço.

Ferramentas existentes (ERP, APS, inventory optimization, meeting copilots) otimizam pedaços ou descrevem reuniões. Quase ninguém **rewira o domínio IBP** com agentes + otimizador + políticas + value board.

## 2. Product thesis (one sentence)

**Domain Rewire OS** para o domínio **IBP / working capital**: líderes de Sales, Supply e Finance definem políticas e rede; agentes geram e dialogam cenários (horizonte até ~18 meses) a partir de histórico + ditado; um **otimizador logístico** materializa planos factíveis sob rotas, janelas, capacidade, custos e **obrigações contratuais**; um **Orchestrator (A7)** devolve takeaways, provoca os agentes de perna e escala o que sair da política — com go-to-market via **learning journey** até conviction (Rewired D3 motion).

## 3. Goals and non-goals

### Goals (grande release)
- Productizar o domínio IBP (vendas + ops/supply + finance) com working capital e serviço como leverage.
- Cadastro de políticas e master data operacional (rede, capacidade, rotas, janelas, custos, contratos de fornecedores).
- Scenario builders agentic (texto/voz → cenário versionado com premissas rastreáveis).
- Otimizador logístico-estoque de primeira classe.
- Integrator multi-cenário vs. política com takeaways executivos.
- Cockpit IBP + audit trail de decisão.
- **Superfícies IA:** Cadastro, Command center (caixa/WC), Visões por perna; wizard de cenário aninhado.
- Pulso de execução: acompanhar movimentações programadas vs. plano (S&OE-ish).
- Journey D3 como motion de venda (não o P&L core).
- Monetização land-and-expand por BU/rede/domínio, ancorada em valor (cash, ruptura, qualidade do consenso).

### Non-goals (anti-escopo explícito)
- Substituir ERP/MES/WMS/TMS core.
- APS “world-class” genérico multi-indústria no dia 1 sem opinionated constraints.
- CPFR multi-enterprise completo.
- Autonomia total sem humano em trade-offs materiais (trust / Rewired tema 10).
- Chat genérico sem domínio, políticas ou otimizador.
- B2C / Job de compra; Job 4 pós-reunião como produto (pode ser feature lateral depois).

## 4. Users and buyers

| Role | Relação com o produto |
|------|------------------------|
| **Buyer econômico** | COO, VP Supply Chain, Transformation lead, CFO/FP&A sponsor | Paga journey + land do domínio |
| **Domain owner** | Líder 1–3 níveis abaixo do C-level dono do IBP/WC | Dono de KPI, políticas, decisões |
| **Sales planning** | Demanda, pipeline, premissas de crescimento/filiais | Scenario builder vendas |
| **Supply / Logistics** | Rede, rotas, capacidade, fornecedores | Optimizer + supply scenarios |
| **Finance / FP&A** | Caixa, margem, investimento, cenários P&L/BS | Finance scenarios + value board |
| **Builders (post-discovery)** | Bots/squads de delivery | Implementam waves da release |

## 5. Domain model (foundation objects)

### 5.1 Policies
- Política de estoque (cobertura, min/max, serviço alvo, ABC/segmentação).
- Política de working capital / cash (limites, prioridades de trade-off).
- Política de serviço (OTIF/fill por canal/cliente/SKU quando aplicável).
- Regras de escalonamento: o que o otimizador pode decidir sozinho vs. o que exige humano.

### 5.2 Network & capacity
- Nós: filiais, CDs, plantas, pontos com armazenagem.
- Capacidade / restrições físicas por nó.
- Calendários e indisponibilidades.

### 5.3 Logistics
- Rotas disponíveis (grafo origem–destino, modo).
- Janelas de entrega por rota.
- Custos de movimento (e/ou proxies) e lead times.

### 5.4 Products & costs
- SKUs / famílias, custo do produto, atributos relevantes ao armazenamento e movimento.

### 5.5 Supplier contracts (obrigatório no optimizer)
- Obrigações contratuais: volumes mínimos, take-or-pay, janelas de pedido, prazos negociados, penalidades, exclusividade, grupos de fornecedores.
- Alavancas dialogáveis: adiar/antecipar prazo, shift de volume entre grupos, impacto em caixa e serviço.

### 5.6 Sales & history
- Histórico de vendas por nó/SKU (e âncoras “filial semelhante a X”).
- Premissas de curva de crescimento, abertura de filial, investimento associado.

### 5.7 Finance drivers
- Mapeamento de volume/preço/prazo/investimento → caixa, margem, indicadores de WC (ex.: DIO e proxies).

Todos os objetos são **versionados** e referenciáveis por cenário e por run do otimizador.

## 6. Agent roster (operating system)

Contagem alvo da grande release: **7 agentes de domínio + 1 motor de otimização (não-LLM) + humanos no escalonamento**. O “Integrator” da visão inicial vira o **Orchestrator** — provoca os demais, resolve o que couber na política e escala o resto.

| ID | Agente | Papel | Provocado por |
|----|--------|-------|----------------|
| **A1** | **Sales Agent** | Premissas e cenários de demanda (filial nova, curva, mix, pipeline); responde a gaps de venda | Orchestrator / usuário |
| **A2** | **Supply Agent** | Premissas de suprimentos, grupos de fornecedores, lead time, shift contratual; monta intenções de compra/transferência | Orchestrator / usuário |
| **A3** | **Finance Agent** | Traduz choques → caixa, margem, investimento, WC; cenários P&L/BS drivers | Orchestrator / usuário |
| **A4** | **Logistics–Inventory Optimizer** | Motor de otimização (solver): rotas, janelas, capacidade, política, custos, **contratos** → plano factível + explicações | Sempre após cenário material |
| **A5** | **Policy & Compliance Agent** | Avalia plano/cenário vs. políticas e contratos; classifica auto-resolvível vs. escalável | Orchestrator |
| **A6** | **Alerts & Exceptions Agent** | Orquestra a fila de alertas (execução vs. plano, violações, infeasibilities); deduplica, prioriza, encaminha | Pulse + Orchestrator |
| **A7** | **Orchestrator (Integrator)** | Visão do todo: provoca A1–A3/A5/A6, dispara A4, sintetiza takeaways, decide *resolver na política* vs. *escalar humano* | Ciclo IBP, pulse, usuário |
| **H** | **Human domain owners** | Trade-offs fora da política / conflito entre pernas / investimento material | Escalado por A7 |

### Loop de orquestração (normativo)
1. Evento (ditado, pulse, alerta, geração automática de cenário).
2. **A7** decompõe e provoca A1/A2/A3 conforme a perna.
3. Cenário versionado → **A4** otimiza.
4. **A5** checa política/contratos; **A6** atualiza alertas.
5. Se resolvível na política → A7 fecha e registra; senão → escala com pacote (premissas + plano + violações + opções).
6. Humano decide → re-otimiza / arquiva.

### O que *não* é agente separado (de propósito)
- “Um agente por tipo de alerta” — fica em **A6** com taxonomia, não frota infinita.
- Chat genérico sem dono de perna — proibido; todo builder tem perna (A1–A3).

### UX (alinhado com Didi)
- Premissas tipadas saem de A1–A3.
- Always-on do otimizador = saída de A4; drill-down = mesmo artefato.
- Cockpit compara até 3 cenários; A7 é a voz dos takeaways.

---

## 7. Core capabilities

### 7.1 Scenario Builders (A1–A3) (Agent A family)
**Input:** texto ou voz + contexto de política/rede/histórico.  
**Exemplos de intents:**
- “Abrir filial porte semelhante à Y, curva natural, investimento Z.”
- “Comprar mais do grupo de fornecedores A vs. B.”
- “Alta de preços no input X.”
- “Se eu adiar 2 dias o prazo do fornecedor, como melhora o caixa?”

**Output:** cenário versionado com:
- Séries geradas (demanda, supply, cash drivers) ancoradas em histórico.
- Premissas explícitas e gaps (“faltou capacidade do CD 3”).
- Rastreabilidade: prompt → premissas → séries → (depois) plano otimizado.

Builders existem por perna (vendas, supply, finance) e podem compor.

### 7.2 Logistics–Inventory Optimizer (A4) (first-class engine)
**Objetivo:** dado um cenário + políticas + rede, produzir plano factível que respeita restrições e tensiona objetivos (serviço, custo, caixa/WC).

**Constraints / inputs (mínimo):**
- Rotas disponíveis e janelas de entrega.
- Vendas / necessidade do cenário.
- Política de estoque.
- Capacidade por nó.
- Custo dos produtos (e custos de mover/segurar quando modelados).
- **Obrigações contratuais com fornecedores.**

**Outputs:**
- Plano de reabastecimento / transferências / compras ao longo do horizonte.
- Posição de estoque por nó no tempo.
- Uso de rotas e janelas.
- Violações, infeasibilities e shadow prices / explicações (“não atendeu X porque janela/capacidade/contrato/custo”).
- Métricas: custo, serviço, cash/WC proxies.

**Design rule:** todo cenário material para decisão passa pelo otimizador antes do Integrator (cenário ≠ wishlist).

### 7.3 Orchestrator, Policy & Alerts (A5–A7)
Ver roster §6. Em resumo:
- **A5** classifica violações auto-resolvíveis vs. escaláveis.
- **A6** orquestra alertas/exceções (não um agente por alerta).
- **A7** provoca A1–A3, dispara A4, sintetiza takeaways e escala humanos com pacote (premissas + plano + violações + opções).

### 7.4 IBP Cockpit
- Comparação de cenários lado a lado.
- Registro de decisão (qual cenário/plano venceu, por quê).
- Audit trail (Rewired trust).
- Value board: cash liberado/consumido, ruptura/expedite, aderência a política, latência de decisão.

### 7.5 Execution pulse (S&OE-ish)
- Acompanhar movimentações programadas vs. plano.
- Fila de exceções diárias/semanais que realimentam cenário ou re-otimização.
- Fecha metabolic rate (insight → decisão → ação).

### 7.6 Learning journey (GTM, D3) — productized motion
Não é o core ARR; é o **filtro e CAC sofisticado**:
1. Leverage points em $ (WC, serviço, expedite).
2. Latência e qualidade do consenso atual.
3. Role clarity (domain owner + Sales/Supply/Finance).
4. Conviction pack → land do OS num escopo (BU/rede/famílias).

## 8. Horizons and time model

- Horizonte de planejamento até **~18 meses**.
- Granularidade: mais fina no curto (dia/semana) e agregada no longo (mês).
- Múltiplas gerações automáticas (baseline, upside/downside, stress de supply, expansão) + cenários dialogados.
- Re-otimização sob demanda quando premissas ou execução divergem.

## 9. Architecture (logical)

```
[Master data & Policies] → [History / ERP extracts]
            ↓
[A1 Sales | A2 Supply | A3 Finance]
            ↓
[Scenario Store (versioned premises + series)]
            ↓
[A4 Logistics–Inventory Optimizer (+ contracts)]
            ↓
[Optimized Plan Store]
            ↓
[A5 Policy] [A6 Alerts] ← [A7 Orchestrator] → [IBP Cockpit / Decisions]
            ↓
[Execution Pulse] ⟷ re-scenario / re-optimize
```

**Platform notes (Rewired-aligned):**
- Data products consumíveis (tema 8) — começar com conectores/extracts opinionated; enriquecer depois.
- Guardrails e avaliação de agentes (temas 10–11).
- Write-back controlado aos sistemas de origem (compras, transferências) em waves posteriores; v1 pode exportar plano aprovado + API stubs.

## 10. UX principles

- **Ditado → estrutura:** linguagem natural vira premissas editáveis, nunca caixa-preta.
- **Humano no trade-off material;** agentes no volume e na montagem.
- **Explicabilidade do otimizador** tão importante quanto o plano.
- **Uma política visível** em todo takeaway (“violou cobertura do CD2”).
- Journey e OS compartilham o mesmo vocabulário de domínio (não dois produtos mentais).

## 11. Product surfaces (IA — além do happy path de cenário)

O fluxo de 5 telas (Ditado → Premissas → Cenário → A4 → Takeaways/Cockpit) é o **wizard “Novo cenário”**, não o produto inteiro. A grande release exige três superfícies de primeira classe (feedback Felipe 2026-10-30):

### 11.1 Cadastro / Foundation (W0 na UI)
CRUD e versionamento dos objetos do §5:
- Políticas (estoque, WC, serviço, alçadas)
- Rede (nós, capacidade)
- Rotas e janelas
- Produtos/custos
- Contratos de fornecedores
- Âncoras de histórico / filiais de referência

Sem cadastro usável, o sistema “não para de pé” — dados demo não substituem o módulo.

### 11.2 Command center — caixa / WC / serviço
Dashboard integrado (não só KPI no fim do wizard):
- Caixa / working capital (proxies e tendências no horizonte)
- Serviço (OTIF/fill) e #violações de política
- Pulse: programado vs. plano, alertas A6
- Atalhos para cenários ativos e decisões pendentes de alçada (ex.: Finance)

### 11.3 Visões por perna (mesma verdade, lentes diferentes)
| Visão | Primário | Secundário (sempre visível, não silo) |
|-------|----------|--------------------------------------|
| **Sales** | Demanda, filiais, cenários A1 | Estoque/serviço impactados |
| **Supply** | Rede, transferências, contratos, A2/A4 | Vendas relevantes ao plano |
| **Finance** | Caixa, investimento, alçadas, A3 | Premissas de volume e custo de servir |

Shell de navegação alvo: **Cadastro · Pulse/Caixa · Visões · Cenários (wizard)**.

Wire UX: shell + Cadastro + Command center *antes* de polarizar só no wizard (v0.3+).

---

## 12. ICP (working assumption for the grande release)

- Indústrias com rede multi-nó (filiais/CDs), estoque relevante em $ e S&OP existente mas frágil.
- Exemplos de fit: manufatura com distribuição própria, process/CPG com restrição de capacidade/armazenagem, supply mid/upper-market.
- Evitar no land inicial: hyperscale OEM com build interno massivo; pure 3PL sem ownership de estoque/política.

*(ICP pode ser afinado na review da spec sem mudar a arquitetura.)*

## 13. Monetization

| Layer | Model |
|-------|--------|
| Journey D3 | Fee por cohort / empresa (qualifica) |
| Land | Subscription do Domain Rewire OS por escopo (BU × rede × famílias) + setup |
| Expand | Mais BUs/plantas; mais profundidade (write-back, mais restrições) |
| Optional | Outcome kicker com baseline limpo (cash / ruptura) |

Evitar: seats de chat; afiliado; T&M eterno sem stickiness do OS.

## 14. Success metrics

### Product / customer
- Redução de latência decisão IBP (ciclo e exceções).
- Melhora em proxies de WC (ex.: DIO) e/ou ruptura/expedite no escopo landado.
- % de decisões com audit trail e premissas rastreadas.
- Adoção: domain owner + Sales/Supply/Finance ativos no cockpit semanalmente.

### Business (our side)
- Conversion journey → land.
- NRR via expand de escopo.
- Gross margin após custo de optimize + LLM.

### Rewired-style ambition (directional)
- Cliente consegue apontar 1 domínio IBP/WC com investimento stage-gated e KPI de negócio — não lista de 40 use cases.

## 15. Release waves (for the later work plan — not a “thin MVP”)

A **grande release** é o sistema completo acima; a implementação é stage-gated:

| Wave | Entrega | Critério de done |
|------|---------|------------------|
| **W0 — Foundation + Cadastro UI** | Policies, rede, capacidade, rotas, janelas, custos, contratos, ingestão + **módulo de cadastro** | Master data usável em runtime; versionamento; CRUD na UI |
| **W1 — Optimizer core** | Otimizador com restrições listadas + explicações | Plano factível + infeasibility reasons em casos de teste |
| **W2 — Scenario builders** | Ditado/texto → cenários Sales/Supply/Finance | Premissas editáveis + séries + trace |
| **W3 — Integrator + Command center + Visões** | Multi-cenário, takeaways, **dashboard caixa/WC**, visões Sales/Supply/Finance | Reunion-ready + pulse + lentes por perna |
| **W4 — Execution pulse** | Programado vs. plano, exceções, re-optimize | Loop diário/semanal fechado no escopo piloto |
| **W5 — Journey productization** | Facilidade D3 + conviction pack → land | Motion repetível de venda |
| **W6 — Write-back & harden** | Integrações duras, guardrails, scale de nós/SKUs | Produção confiável no ICP |

Dependência dura: **W0 → W1 antes de W3** (Integrator só sobre planos otimizados).

## 16. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Virar projeto de dados infinito | Escopo land estreito (nós/SKUs); extracts opinionated; gaps explícitos no cenário |
| Otimizador caixa-preta | Explicações obrigatórias; human approval em trade-offs |
| Contratos mal modelados | Modelo de obrigação versionado; lib de templates por tipo contratual |
| Escopo IBP explode | Spec completa + waves; anti-escopo policed no plano |
| Confiança / OT-IT | Guardrails, audit, sem autonomia total no v1 de write-back |
| Commodity vs. agent platforms | Opinionated domain IBP + optimizer + policy — não chat |

## 17. Acceptance criteria for “put spec done → plan”

Esta spec está pronta para `writing-plans` quando Felipe aprovar que:
1. Domínio, anti-escopo e objetos 5.x estão corretos.
2. Optimizer inclui rotas, janelas, capacidade, vendas, política, custos **e contratos**.
3. Roster A1–A7 + horizontes ~18 meses estão corretos.
4. Waves W0–W6 são a base do plano de trabalho da grande release.
5. Monetização e GTM D3 permanecem alinhados.

## 18. Open points (explicit — resolve in review or plan)

- Afinar ICP (indústria/porte) sem bloquear arquitetura.
- Função objetivo default do otimizador (pesos serviço vs. custo vs. caixa) e como a política os sobrescreve.
- Nível de fidelidade do modelo de capacidade no W1 vs. W6.
- Idioma/UX de voz no builder (pt-BR first).
- Stack técnico (solver, orquestração agentic, data plane) — **fora desta spec de produto**; entra no plano de implementação.

---

## Document history

- 2026-10-29: Draft inicial a partir do discovery (Rewired D1+D3, vertical ops/supply, leverage WC/estoque, IBP com Sales+Finance, cenários agentic, otimizador logístico + contratos).
- 2026-10-30: Roster explícito de 7 agentes (A1–A7) + optimizer; Orchestrator provoca pernas, resolve na política e escala.
- 2026-10-30: Superfícies IA §11 — Cadastro, Command center caixa/WC, Visões por perna; 5 telas = wizard Novo cenário.
