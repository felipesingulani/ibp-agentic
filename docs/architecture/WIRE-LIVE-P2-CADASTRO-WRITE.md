# Wire→live P2 — Cadastro write (browser → Neon)

Status: **rascunho arch Deivid · 2026-10-31 · 3 cravos PO CRAVADOS 2026-10-31 (mestres live · ack LS · guard client) · eng Devi · UX Didi** · task **T-DOM-CAD-PREP** · **sem migration / sem endpoint novo**

## 1. Objetivo
Com `?live=1`, o shell (prod `b697027d…`, overlay P1) deixa de gravar Cadastro no mock in-memory/localStorage e passa a chamar a **API W3b já no ar** (Task 9): políticas (criar/editar/aposentar), aplicar pack, `PUT` settings (inclui `confirmed`), `PUT` alçada e — conforme cravo 1 — mestres via CRUD genérico. Objetivo de produto: tenant **vazio → 1º cenário destravado** só com dados reais no Neon. Journey / Execution / A4 POST / wizard / export seguem mock.

## 2. Pré-requisitos
- **P1 green** (`WIRE-LIVE-P1-PULSE-CADASTRO.md`): GETs live + gate `LIVE_GATE` = `unlock.new_scenario` ∧ `alcResolved()`.
- **W3b green** (`W3B-CADASTRO-WRITE-API-CONTRACT.md`): `0013` aplicada, hooks `src/cadastro/alcada-write.ts` no CRUD de `policies`.
- **Embed ship fechado** (T-EMB-SMOKE green no `b697027d…`). P2 rebaseia em cima do wire canônico vigente.

## 3. Rotas live P2 (só escrita que pluga — todas existem em `src/http/app.ts` / `src/http/cadastro.ts`)
| Método | Path | Notas |
|---|---|---|
| POST | `/api/policies` | `{kind, name, body?, why?}` → 201 `{data, packSwitched?, warnings?}`; `409 already_exists` (kind+name), `409 alcada_exists`; kind fora do vocab = 201 + `warnings[policy_kind_unknown]` |
| PATCH | `/api/policies/:id` | nova versão; `why` **obrigatório**; `kind` **e** `name` = business key imutável → 400; `409 not_current_version`; `limitMi` estrito em POL de alçada |
| DELETE | `/api/policies/:id` | retire (`?why=` ou body); `409 alcada_required_in_pack` na última POL de alçada |
| POST | `/api/cadastro/pack` | `{pack, why}` → `{data: settings, alcadaEffect}`; `400 invalid_pack` |
| PUT | `/api/tenant-settings` | parcial `.strict()`: currency/uom/node_types/kpi_labels/supply_external_in_scope/**confirmed**/entity_labels/policy_kinds/agent_roster; `industry_pack` → `400 use_pack_endpoint` |
| PUT | `/api/cadastro/alcada` | `{limitMi: number≥0\|null, why}` → `{data, policy, action, packSwitched}` |
| POST/PATCH/DELETE | `/api/{nodes,node_capacity,skus,routes,supplier_contracts}` | **só se cravo 1 = sim**; mesmo router genérico (refs por `stable_id`, `node_type` validado contra settings) |

**Continua MOCK em P2:** `POST /api/scenarios` (+ premise_cards/ditado), `POST /api/a4-runs`, `/api/execution/*`, `/api/journey/*`, `POST /api/decision-events`, export W7, `finance_drivers` e `sales_history` ingest, passos/contagem do coach B, `alcada_zero_ack` (cravo 2), `409 scope_requires_masters` no servidor (cravo 3).

## 4. O que o shell troca
1. **Políticas:** `polApiCreate` / `polApiUpdate` / retire (inclui `polRetireReplaced` = criar nova + `DELETE` da antiga) → `fetch` com headers. Mapeamento: `nome→name`, `kind→kind`, `escopo/metrica/valor/acao/dono→body` (jsonb). Drawer: `name` também só leitura em edição (API recusa); renomear = nova + aposentar.
2. **Pack:** `applyPack` → `POST /api/cadastro/pack` e re-render com a resposta (labels/kinds/roster/node_types do servidor; `alcadaEffect` vira toast). Não reaplicar pack local.
3. **Settings / confirmar defaults:** salvar Config do tenant → `PUT /api/tenant-settings` (diff só das chaves tocadas); “Confirmar” → `{confirmed:true}`; depois **re-GET** `/api/a4-readiness` (gate P1 recalcula; nada otimista).
4. **Alçada:** publicar/editar/limpar → `PUT /api/cadastro/alcada`; `packSwitched` → toast “pack → generic”; `alcMode` passa a vir de `GET /api/tenant-settings.alcada.mode`.
5. **Erros:** 4xx/5xx → banner/field error com `error` + `details` da API (400 zod por campo; 409 com código). **Nunca sucesso fingido**, nunca fallback silencioso p/ mock. Botão desabilitado durante inflight (anti duplo-POST); após sucesso, invalidar cache P1 (`LV.cache`, TTL 5 s) das rotas afetadas.
6. **Fora do overlay nada muda:** código acima do overlay segue byte-idêntico ao wire da Didi (mesma regra do P1/Embed).

## 5. Flag
Igual P1: `window.IBP_LIVE===true` ou `?live=1`. Sem flag = 100 % mock (rollback sem redeploy). Headers: `x-tenant-id` (IBP_TENANT_ID › `?tenant_id=` › seed) · `x-user-id` (IBP_USER_ID › `ibp.live.userId` › seed admin). Escrita sem `x-user-id` válido → 401 → banner.

## 6. Seed checklist empty → 1º cenário (Devi / Qualidade)
Tenant de teste **dedicado** (não sujar o seed demo `e5cf5324…`; Devi provisiona UUID novo + user admin, sem migration).
- [ ] Headers: `x-tenant-id` + `x-user-id` do tenant de teste; sem header → 401 (escritas e GETs).
- [ ] Estado inicial: `GET /api/a4-readiness` → `state=block`, `unlock.confirmed=false`, `new_scenario=false`; gate travado.
- [ ] Pack: `POST /api/cadastro/pack {pack:"generic", why}` → POL de alçada criada com `limitMi=2` (`alcadaEffect`), `mode=active`.
- [ ] Settings: `PUT /api/tenant-settings {confirmed:true}` → `confirmed_at` = now() do servidor (não do browser).
- [ ] Mestres (cravo 1): ≥1 `nodes` (node_type ∈ pack) → `node_capacity` (node_id = stable_id) · ≥1 `skus` · ≥1 `routes` (origem/destino) · `supplier_contracts` só se `supply_external_in_scope`.
- [ ] Política: ≥1 POL `working_capital` **ou** inventory+service (regra `polOk` da readiness).
- [ ] Alçada: `PUT /api/cadastro/alcada {limitMi:null}` → `misconfigured` → gate travado (ou ack local, cravo 2); `{limitMi:2}` → `active`.
- [ ] Fim: readiness ≠ block ∧ confirmed ∧ alçada resolvida ⇒ `new_scenario=true` ⇒ CTA “Novo cenário” destrava **live** (wizard em si segue mock).
- [ ] `audit_log` com `why` em create/update/retire/pack/alçada; tenant B não vê nada de A (RLS).

## 7. 3 cravos PO
1. **Entidades graváveis no V0 live:** recomendo **políticas + pack + settings + alçada + mestres W0** (`nodes`, `node_capacity`, `skus`, `routes`, `supplier_contracts`) pelo CRUD genérico já existente — sem mestres live o tenant vazio **nunca** sai de `block` (readiness exige capacity/sku/route). `finance_drivers` e `sales_history` ficam mock. Alternativa enxuta: só políticas/pack/settings/alçada e mestres via script de seed (aí o empty→1º cenário não é “pelo shell”).
2. **`alcada_zero_ack`:** recomendo **continuar localStorage** (tenant+user) sob live nesta fatia — o `settingsSchema` é `.strict()` e não há coluna; persistir no servidor exige migration (fora). Ack **não** muda `alcada.mode` (delta §2).
3. **`409 scope_requires_masters`:** recomendo **Express adiado** (policies não tem `scope`; só `body`). Sob live o shell faz **guard client-side** com contagem live de `nodes`/`skus` (GET P1) antes do POST/PATCH — bloqueia publish, mesma copy do mock. Servidor ganha o 409 só com contrato de campo `body.scope` (fatia própria).

## 8. DoD
- [ ] Com flag + headers: criar/editar/aposentar POL, aplicar pack, PUT settings/confirmed, PUT alçada → **200/201 reais**, refletidos no re-GET e no Neon (audit com `why`).
- [ ] Erros da API (400/401/409) aparecem como banner/campo com o código; zero sucesso fingido; zero escrita mock com flag on.
- [ ] Checklist §6 completo num tenant vazio → gate “Novo cenário” destrava live.
- [ ] Flag off: regressão mock 100 % (smoke embed + coach B iguais ao `b697027d…`).
- [ ] Sem endpoint novo, sem migration, sem grant; código fora do overlay byte-idêntico ao wire.

## 9. Fora
Journey, Execution, A4 POST, wizard/scenario create, decision-events, export W7, auth/RBAC real (headers stub), `alcada_zero_ack` no servidor, `scope` em policies no servidor, `finance_drivers`/`sales_history` ingest, Visões write (não existe).

## 10. Sugestão próximo (pós-cravos)
- **Eng (Devi):** thin no overlay — wrapper `lvWrite(method,path,body)` (headers, inflight, invalida cache, banner) + troca dos 4 pontos (§4); provisiona tenant de teste.
- **UX (Didi):** marcar no wire os pontos de troca (drawer POL `name` read-only, toasts `alcadaEffect`/`packSwitched`, banners de erro por código); sem mudar layout.
- **QA (Qualidade, T-DOM-QA-CAD):** checklist §6 como E2E empty→1º cenário + regressão flag off.
