# A1 CurvaDemanda — contrato eng (Path C · hist → curva 18m)

**Status: APPROVED BY PO CRAVOS 2026-10-31 — awaiting eng/UX DoD**
Autor: Deivid (Arquiteto) · Task eng **T-A1-CURVA** (Devi) · UX **T-A1-UX-PREP** (Didi) · QA **T-A1-CURVA** (Qualidade)
Base: `A1-CURVA-CRAVOS-REC.md` (5 cravos sim×5) · `QA-ACCEPTANCE-A1-CURVA.md` (M1–M5 / H1–H5) · `W2-WIZARD-API-CONTRACT.md` · `contracts/premise-card.schema.json` · `DATA-MODEL.md` §4.2 `premise_cards` / `sales_history` · produto `2026-10-29-ibp-agentic-domain-rewire-design.md` (A1 Sales · horizonte ~18m · "ditado → premissas editáveis, nunca caixa-preta").

---

## 1. Escopo
- A1 gera cartão `CurvaDemanda` **v1** (`fields.schema = "a1.curva.v1"`) dentro do `POST /api/scenarios/:id/ditado` existente.
- Série **18 pontos mensais** calculada **no servidor, de forma determinística**, a partir de `sales_history` do nó âncora (current, mesmo tenant). O LLM só extrai **intenção + parâmetros + âncora** — **nunca números da série**.
- `≥ 6` meses de hist no âncora → `status=ok` + série; abaixo → `status=gap` + `gapCode` tipado + `series: []`.
- Edição (`PATCH /api/premise_cards/:id`) de parâmetros → **recalcula** a série + bump `version` + audit `why`.
- Fixture QA: tenant `qa-a1-*` (E0 `e5cf…` intocável).

## 2. Fora de escopo / anti-goals
- **Sem** A4 (modelo/solver não lê a curva na V0; A4 segue lendo `sales_history` último período) · **sem** A7 (prose/orquestração — T-A7-LEVE depois) · **sem** Journey · **sem** Execution · **sem** ERP / write-back.
- **Sem** endpoint novo (`/api/a1/curva` proibido na V0) · **sem** tabela auxiliar · **sem** escrita em `sales_history` (ingest read-only para A1).
- **Sem** forecast estatístico (ARIMA/ML), sem sazonalidade, sem mix por SKU além do filtro opcional `skuStableId`.
- **Sem** aplicar canibalização na demanda de outro nó (só registrada como premissa).
- Pulse WC 18m chart continua fora (removido W3 V0). Readiness e CTA A4: **inalterados**.

## 3. API — deltas no `POST /api/scenarios/:id/ditado`
**Request:** inalterado — `{ "text": string(1..4000) }` strict. Nenhum campo novo.

**LLM (saída crua, não confiável)** — para `type="CurvaDemanda"` o prompt passa a pedir:
```json
{ "type": "CurvaDemanda",
  "anchorRef": "<code|stable_id de nó da lista>",      // "semelhante a X"
  "skuRef": "<code|stable_id de SKU>|null",
  "nodeRef": "<nó alvo (filial nova) ou null>",
  "fields": { "perfil": "natural|linear|degrau", "rampUpMeses": 9,
              "maturidade": { "pct": 100, "mes": 12 },
              "canibalizacao": { "pct": -6, "nodeRef": "FL-SJRP" } } }
```
Qualquer `series`/`qty` vindo do LLM é **descartado** (nunca persiste). Parâmetro ausente → default (§4).

**Pipeline servidor (fase 2, dentro do `withTenant` que já persiste, por cartão com SAVEPOINT):**
1. Roster: A1 efetivo (`agents.A1.enabled` do pack + override `tenant_settings`) = false → rejeita `a1_disabled`.
2. Resolve `anchorRef` → `nodes.stable_id` **current** do tenant (mesmo mapa code|stable_id do ditado). Inexistente / aposentado / outro tenant → rejeita `invalid_reference` (`field: "fields.anchor.nodeStableId"`). `anchorRef` ausente → card `gap` `anchor_missing`.
3. `skuRef` (opcional) → `skus.stable_id` current; inválido → `invalid_reference` (`fields.anchor.skuStableId`).
4. Lê hist (§5); calcula série ou gap.
5. Dedupe (H4): já existe `CurvaDemanda` v1 no cenário com mesma `(anchor.nodeStableId, anchor.skuStableId, links.nodeId)` → rejeita `duplicate_curve` (`detail.cardId`). Lock = `pg_advisory_xact_lock` já usado no `nextCardId`.
6. `insertCard` (`source=ditado`) + audit `create` (já existe) + audit `ditado` do cenário (já existe).

**Response:** envelope **inalterado** `201 { data: PremiseCard[], rejected: Rejected[], cached }`. `data[]` traz o card v1 (§4). Novos `rejected[].reason`: `a1_disabled` · `invalid_reference` (âncora/SKU) · `duplicate_curve`. Nenhum válido → `422 ditado_no_cards` (já existe). LLM fora → `502 ditado_unavailable` (já existe).

**Leitura:** `GET /api/scenarios/:id` (cards aninhados) devolve o card com `fields` completo — sem endpoint novo.

**Edição — `PATCH /api/premise_cards/:id` (rota existente):**
- Editáveis: `perfil`, `rampUpMeses`, `maturidade`, `canibalizacao`, `anchor.nodeStableId`, `anchor.skuStableId`. `why` obrigatório (audit `update`).
- `series`, `anchor.periodsUsed`, `trace`, `gapCode`, `status` são **derivados** → enviados pelo cliente = `400 validation_failed` (`field: "fields.series"` etc.).
- Servidor re-resolve âncora + relê hist + recalcula → pode virar `ok ↔ gap`. `version + 1`, `source=edit`.
- `POST /api/scenarios/:id/premise_cards` (manual) com `fields.schema="a1.curva.v1"` → mesma validação/derivação do ditado (cliente não injeta série).

## 4. Card JSON — `CurvaDemanda` v1 (`premise_cards.fields`, jsonb)
| Campo | Tipo / regra | Origem |
|---|---|---|
| `schema` | const `"a1.curva.v1"` | servidor |
| `perfil` | enum `natural` (S-curve) · `linear` · `degrau`; default `natural` | LLM/edit |
| `rampUpMeses` | int 1–18; default 9 | LLM/edit |
| `maturidade` | `{ pct: number 1–200, mes: int 1–18 }`; default `{pct:100, mes: rampUpMeses}`; `mes ≥ rampUpMeses` | LLM/edit |
| `canibalizacao` | `{ pct: number -100..0, nodeStableId: uuid\|null, nodeRef: string\|null }` ou `null`; **registrada, não aplicada** (§2) | LLM/edit |
| `anchor` | `{ nodeStableId: uuid (current), skuStableId: uuid\|null, periodsUsed: int 0–12 }` | servidor (resolve) |
| `series` | `[{ period: "YYYY-MM", qty: number ≥0 (2 casas), factor: number }]` — **exatamente 18** se `ok`; **`[]`** se `gap` | servidor |
| `uom` | string = `tenant_settings.uom` / pack | servidor |
| `trace` | `{ method: "a1.curva.v1", histFrom: "YYYY-MM", histTo: "YYYY-MM", baseQty: number, histSource: "sales_history" }` (`null` em gap sem hist) | servidor |
| `gapCode` | `null` se ok · `hist_none` · `hist_insufficient` · `anchor_missing` | servidor |
| `nodeRef` | (existente) ref de nó alvo não cadastrado (filial nova) | LLM |

- `links.nodeId` = nó **alvo** (filial) se já existir current; `null` p/ filial nova (ref em `fields.nodeRef`). Âncora **não** vai em `links` (fica em `fields.anchor`) — CHECK do Gap intocado.
- Validação: novo `curvaFieldsSchema` (zod) em `src/wizard/cards.ts` aplicado quando `type=CurvaDemanda` **e** `fields.schema="a1.curva.v1"`; teto 8 KB serializado. O `fieldsSchema` escalar atual segue para os demais tipos.
- **Back-compat (M5):** `CurvaDemanda` legado (sem `schema`, mapa escalar — ex. testes W3 `{growth}`) continua aceito/lido como hoje; UI/QA só tratam como curva A1 o v1. Wire preview "Mês 3/12" = UI lendo `series[2]`/`series[11]`; payload canônico = 18.
- `contracts/premise-card.schema.json`: adicionar `if type=CurvaDemanda ∧ fields.schema=a1.curva.v1 then fields ⇒ $defs/curvaDemandaV1` (sem quebrar `additionalProperties` dos outros tipos).

## 5. Hist → série (determinístico, rastreável — M1)
1. `H` = `SELECT left(period,7) AS m, sum(qty) FROM sales_history WHERE node_id = :anchor [AND sku_id = :sku] GROUP BY 1 ORDER BY 1 DESC LIMIT 12` (RLS do tenant; YYYY-MM-DD agregado no mês).
2. `periodsUsed = |H|` (meses distintos, buracos permitidos). `0` → `gap hist_none`; `1–5` → `gap hist_insufficient`; `≥6` → ok.
3. `baseQty = média(H.qty)`; `histFrom/histTo` = min/max de `H.m`.
4. Horizonte: `series[0].period` = mês seguinte a `histTo`; `i = 0..17`, `t = i+1`. `P = maturidade.pct/100`, `M = maturidade.mes`.
   - `linear`: `f(t) = P · min(t/M, 1)`
   - `degrau`: `f(t) = t < rampUpMeses ? 0 : P`
   - `natural`: `s(t) = 1/(1+e^{-(10/M)(t − M/2)})`; `f(t) = t ≥ M ? P : P · s(t)/s(M)`
   - `qty = round(baseQty · f(t), 2)`; `factor = round(f(t), 4)`.
5. Mesmo hist + mesmos params ⇒ série byte-idêntica (teste unit obrigatório). Zero aleatoriedade, zero LLM.

## 6. Status / códigos
| Situação | HTTP / resultado |
|---|---|
| Âncora current + ≥6 meses | card `status=ok`, `series[18]`, `gapCode=null` |
| Âncora current + 0 meses | card `status=gap`, `gapCode=hist_none`, `series=[]` |
| Âncora current + 1–5 meses | card `status=gap`, `gapCode=hist_insufficient`, `anchor.periodsUsed=n`, `series=[]` |
| Sem âncora no ditado | card `status=gap`, `gapCode=anchor_missing`, `series=[]` |
| Âncora/SKU inexistente · aposentado · outro tenant | `rejected[] invalid_reference` (zero card); PATCH/POST manual → `400 invalid_reference` |
| A1 off no roster | `rejected[] a1_disabled`; POST manual v1 → `409 a1_disabled` |
| Curva duplicada no cenário | `rejected[] duplicate_curve` |
| Nenhum card válido | `422 ditado_no_cards` (existente) |
| Cliente envia `series`/derivados | `400 validation_failed` |
| LLM indisponível/teto | `502 ditado_unavailable` (existente) |

Gap **nunca** vira `ok` silencioso; UI mostra banner com `gapCode` + `periodsUsed` (Didi).

## 7. RLS / segurança
- Tudo via `withTenant` (`app.tenant_id`) — leitura de `sales_history`, `nodes`, `skus` e escrita em `premise_cards` sob **FORCE RLS**; **nunca** `tenant_id` em WHERE vindo do request.
- Âncora/SKU validados como current **do tenant** (`assertCurrentRefs`); FK composta `(tenant_id, node_id)` de `premise_cards` segue para `links.nodeId`. `anchor.*` (jsonb) não tem FK → validação na API é obrigatória e coberta por teste cross-tenant.
- Role `ibp_app`: grants **já existentes** bastam (`SELECT sales_history` 0004 · `SELECT/INSERT/UPDATE premise_cards`/`scenarios` 0011). Nenhum grant novo.
- LLM recebe só codes/nomes de nós do próprio tenant (já hoje); **não** recebe `sales_history`.
- Audit: `create`/`update` em `premise_cards` com `data` incluindo `anchor` + `trace` (sem série completa no audit além do card).

## 8. Migration
**NENHUMA.** `premise_cards.fields` já é `jsonb`; `type` CHECK já inclui `CurvaDemanda`; `status` CHECK `ok|gap` já basta; grants já cobrem. Mudanças são só de app (`src/wizard/cards.ts`, `src/wizard/ditado.ts`, `src/http/scenarios.ts`, `src/http/premise-cards.ts`, novo `src/wizard/curva.ts`) + `contracts/premise-card.schema.json`. Se o eng achar necessidade de DDL → **para e volta pro arch** (fora do cravo 4).

## 9. DoD eng (Devi)
- [ ] `src/wizard/curva.ts` — função pura `buildCurva(hist, params) → {status, series, trace, gapCode, periodsUsed}` + unit (3 perfis, limites 5/6 meses, determinismo, 18 pts, qty ≥0).
- [ ] `curvaFieldsSchema` + roteamento por `type`/`schema` em `cards.ts`; legado inalterado; schema JSON atualizado.
- [ ] Ditado: prompt pede `anchorRef/skuRef`; descarta série do LLM; resolve âncora; roster A1; dedupe; reasons novos em `rejected[]`.
- [ ] PATCH/POST manual: derivados read-only (400), recálculo, `version+1`, audit `why`.
- [ ] Integração (mock LLM, sem rede): M1 ok 18 pts rastreável (`trace` = hist seeded) · M2 âncora aposentada/cross-tenant/inexistente → `invalid_reference` · M3 0 e 5 meses → gap tipado, `series=[]` · M4 GET reflete + PATCH bump · M5 tenant B não lê série/hist de A · H4 re-ditado → `duplicate_curve` · H5 A1 off → `a1_disabled`.
- [ ] Regressão: suites W2/W3/W7/Dom/Embed green; `CurvaDemanda` legado (W3 test `{growth}`) intacto; gate W2 LLM só em `src/wizard/`.
- [ ] Fixture `seed:a1-fixture qa-a1-<data>` (nós âncora com 12 / 5 / 0 meses) — **só** tenant `qa-a1-*`; E0 `e5cf…` intocado.
- [ ] Zero migration, zero endpoint novo, zero write em `sales_history` (grep gate: nenhum `INSERT|UPDATE|DELETE … sales_history` em `src/wizard/`).
- [ ] Evidência: md5 overlay/API + log de teste + curl proof (`docs/architecture/T-A1-CURVA-EVIDENCE.md`).

## 10. DoD UX (Didi) — interface com o eng
- Card CurvaDemanda: preview Mês 3 / Mês 12 / spark lido de `series` (18) com hint "18m"; params editáveis tipados (enum/int/pct), sem string solta.
- Banner gap por `gapCode` (+ `periodsUsed`/mín. 6); zero série desenhada em gap.
- Âncora exibida (code do nó) + `trace.histFrom–histTo`; CTA disabled durante request (H4).
- Flag off / mock wire inalterado.

## 11. Ordem
Contrato (este) → Devi eng ‖ Didi UX (wire) → arch review → Qualidade T-A1-CURVA no `qa-a1-*` → publish. **Prioridade #1 do squad segue Dom seed / Dom green**; A1 não fura essa fila de publish.
