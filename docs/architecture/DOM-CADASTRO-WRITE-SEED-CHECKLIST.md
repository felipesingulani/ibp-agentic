# T-DOM-CAD-PREP — Seed checklist · Cadastro write (Dom prep)

Status: **rascunho eng Devi · 2026-10-31** · owner seed: Devi · contrato: [`WIRE-LIVE-P2-CADASTRO-WRITE.md`](./WIRE-LIVE-P2-CADASTRO-WRITE.md) (Deivid) · UX empty/seed: Didi · aceite: Qualidade (T-DOM-QA-CAD)
Alinha ao §6 do P2 (empty→1º cenário). Os 3 cravos **deste** doc (§5) são só seed/provisionamento; os 3 cravos do P2 (mestres live · ack LS · guard client) ficam no contrato Deivid.
Regra da fatia: **docs only** — zero mudança em `src/db/seed*.ts`, API, migration ou dado de prod até os **3 cravos PO** (§5).
Fonte do inventário: código no box (`src/db/seed.ts`, `src/db/seed-demo-alcada.ts`, `src/domain/entities.ts`, `src/http/app.ts`, `src/http/cadastro.ts`, `db/migrations/0002–0017`, `packs/*`) + **GET read-only** em prod (`https://ibp-agentic.vercel.app/api/*`, headers seed) em 2026-10-31 ~11:35 (BRT).

---

## 1. Inventário — o que o seed tem hoje

### 1.1 Scripts de seed
| Script | O que grava | Idempotente | Via |
|---|---|---|---|
| `npm run seed` (`src/db/seed.ts`) | `tenants` (slug `demo`) + `users` 1× `admin` (`admin@demo.local`) + `tenant_settings` linha vazia | ✅ (`ON CONFLICT`) | `MIGRATION_DATABASE_URL` (owner) |
| `npm run seed:demo-alcada [-- slug]` (`src/db/seed-demo-alcada.ts`, default `sample-demo`) | `industry_pack='generic'` se NULL + POL `alcada` `limitMi=2` via `upsertAlcada` (audit `why`) | ✅ (mantém POL existente; não reverte `out_of_pack`) | owner p/ lookup slug → depois `ibp_app` + RLS |
| `test/integration/helpers.ts` | `seedTenant(test-a-*/test-b-*)` p/ testes RLS | ✅ por slug | owner |

**Não existe** seed de entidades de cadastro (nó, capacidade, rota, SKU, contrato, política, finance_drivers, sales_history). O tenant nasce **vazio por desenho** (comentário do `seed.ts`: “cadastro 0%; amostras ficam a cargo do usuário/curl”).

### 1.2 Estado prod (tenant seed `e5cf5324-7a2b-4e95-80c8-fd119b7bede7`, admin `60519ce8-6a2b-4a44-acc8-2e452fe7d1bf`)
| Item | Prod hoje | Fonte |
|---|---|---|
| `/api/me` | `role=admin` | users |
| Rede: `nodes` / `node_capacity` | 0 / 0 | GET |
| `routes` | 0 | GET |
| `skus` | 0 | GET |
| `supplier_contracts` | 0 (`supply_external_in_scope=false` → item n/a) | GET |
| `policies` (WC / estoque / serviço) | 0 | GET |
| Alçada (POL-04) | **nenhuma** → `mode=no_policy` (fail-closed); fila `nextStep=publish_alcada` | `/api/alcada/queue` |
| `finance_drivers` / `sales_history` | 0 / 0 | GET |
| `tenant_settings` | `industry_pack=null`, `currency/uom=null`, `node_types=[]`, `kpi_labels/entity_labels/policy_kinds/agent_roster={}`, `confirmed_at=null` | GET |
| Packs (registry, não DB) | 5: `generic`, `oilgas`, `cpg`, `retail` (alçada default 2), `generic_no_alcada` | `packs/*/profile.json` |
| Prontidão A4 | `block` 0/4 (node_capacity, sku, route, policy = falta; contrato n/a) · `unlock.new_scenario=false` | `/api/a4-readiness` |

➡️ O tenant de prod é o **empty-tenant de referência** que sustenta o smoke `#cenarios/novo` empty (T-EMB-SMOKE). Qualquer write nele quebra esse smoke (ver cravo 1).

### 1.3 Write path que já existe (W0 + W3b — não é trabalho novo)
| Entidade | Endpoint | Regras relevantes p/ seed |
|---|---|---|
| policies / nodes / node_capacity / routes / skus / supplier_contracts / finance_drivers | `POST /api/<path>` · `PATCH /:id` (nova versão, `why`) · `DELETE /:id` (= **retire**, `is_current=false`, histórico fica) | `requireUser` (`x-user-id`); refs por `stable_id` corrente; `node_type` validado contra `tenant_settings.node_types` **se não vazio** |
| sales_history | `POST` (1 linha ou `{rows:[…]}` ≤5000) · `DELETE` físico | refs nó/SKU |
| tenant_settings | `PUT /api/tenant-settings` (parcial; `confirmed:true/false`) | não aceita `industry_pack` |
| pack | `POST /api/cadastro/pack {pack, why}` | descarta overrides; cria alçada 2 se pack com alçada |
| alçada | `PUT /api/cadastro/alcada {limitMi, why}` | `null` = misconfigured (closed) |

Grants `ibp_app`: `SELECT, INSERT, UPDATE` nas tabelas de cadastro (**sem DELETE**, exceto `sales_history`); `users`/`tenants` = **só SELECT**. ⇒ a API **não** cria usuário nem tenant, e **não** apaga cadastro (só retire).

---

## 2. Gaps — Dom empty-tenant × write happy path

### 2.1 Dois estados que o QA precisa ter, separados
| Estado | Uso | O seed precisa ter | Hoje |
|---|---|---|---|
| **E0 · Empty** | smoke `#cenarios/novo` empty, coach B, gate `gateNew`, alçada `no_policy` | tenant + admin + `tenant_settings` vazio, **nada mais** | ✅ = prod `e5cf…` |
| **E1 · Ready (pós-write)** | happy path Cadastro write → readiness `ok` → `confirmed` → Novo cenário → A4 | ver fixture mínima §2.2 | ❌ não existe seed; só via curl manual |

### 2.2 Fixture mínima E1 (o que o happy path de write precisa ter gravado, na ordem de dependência)
1. [ ] Pack aplicado (`POST /api/cadastro/pack {pack:"generic"}`) → `node_types=[CD,Filial,Planta]`, `uom=un`, labels, `policy_kinds`, alçada POL `limitMi=2` (**active**).
2. [ ] **2 nós** (`node_type ∈ node_types` do pack) — rota exige origem ≠ destino na prática (FK `origin/dest` → `stable_id` corrente).
3. [ ] `node_capacity` corrente com `capacity_per_period > 0` em ≥1 nó (item `node_capacity`).
4. [ ] ≥1 SKU corrente (item `sku`).
5. [ ] ≥1 rota corrente entre os 2 nós (item `route`).
6. [ ] Política: 1× `working_capital` **ou** (`estoque` + `servico`) com `kind` no vocabulário do pack (senão warning `policy_kind_unknown` e o item não conta).
7. [ ] (opcional, só se `supply_external_in_scope=true`) ≥1 `supplier_contract` com `sku_ids` = `stable_id` do SKU.
8. [ ] `PUT /api/tenant-settings {confirmed:true}` → `unlock.new_scenario=true`.
9. [ ] Fora do mínimo (não bloqueia readiness): `finance_drivers`, `sales_history` (este vira obrigatório só no **A1 CurvaDemanda 18m**, Path C — não semear agora).

### 2.3 Gaps concretos (eng)
- **G1 — Sem reset.** `ibp_app` não tem DELETE; retire deixa histórico; `industry_pack` não volta a `NULL` pela API; POL de alçada só é retirada trocando p/ `generic_no_alcada`. ⇒ **o tenant de prod não volta a E0** depois de um write happy path. Reset real = tenant novo (owner) — ver §4 / cravo 1.
- **G2 — Só papel `admin`.** Seed não cria `domain_owner|sales|supply|finance`; API não cria usuário (só SELECT em `users`). Testes de alçada Finance / land / export por papel precisam de usuários no seed (owner) — ver §3 / cravo 3.
- **G3 — Nenhum seed de entidades.** E1 hoje só via curl manual (não reprodutível). Proposta: script `seed:dom-fixture` que grava **pela API/mesmo write path** (zod + RLS + audit `why`), nunca SQL direto em tabela de cadastro.
- **G4 — Legado `policy_kinds={}`** em prod (`industry_pack=null` ≡ generic, fail-closed): fixture deve **aplicar pack explicitamente** para não depender do fallback legado.
- **G5 — Neon “claim” 72h** (DEPLOY.md): confirmar com Deivid que o DB de prod está claimed antes de criar tenants de QA nele (senão o seed some junto).

---

## 3. Papéis para testes de write
`users.role` ∈ `domain_owner | sales | supply | finance | admin` (CHECK do contrato). RBAC do Cadastro write = **stub** (só exige `x-user-id`; contrato W3b “Fora”).

| Papel | Por que o QA precisa | Já usado em |
|---|---|---|
| `admin` | dono do setup: pack, alçada, entidades, `confirmed` | seed atual (único) · mapeado p/ `domain_owner` no `DecisionEvent` |
| `domain_owner` | aprova/escalona; land (W6 `LAND_ROLES=admin|domain_owner`); export | A7 / journey / plans |
| `finance` | decide item de alçada (fila só sai com `actor.role=finance`); export (`EXPORT_ROLES`) | W3 alçada, W7 |
| `sales` | caso negativo: Investimento > limiar → `403 alcada_finance_required` | gate decision-events |
| `supply` | opcional (sem regra de papel hoje) | — |

Mínimo proposto p/ tenant de QA: **admin + domain_owner + finance + sales** (4 usuários, e-mails `*@qa-dom.local`). Write de Cadastro em si roda com `admin`; os outros 3 são p/ o E2E pós-write (gate/fila) da T-DOM-QA-CAD. **Não** abre RBAC no write (fora).

---

## 4. Passos idempotentes + reset (QA)
Princípio: **E0 nunca é mutado**; E1 vive em tenant(s) descartáveis. Seed = owner só p/ tenant/usuários; todo o resto pela API (mesmo caminho do produto, audit `why`).

```
# S0 — pré-flight (read-only)
GET /health ; GET /api/me ; GET /api/a4-readiness   # E0 continua block 0/4

# S1 — tenant + usuários (owner, idempotente por slug/email)        [precisa cravo 1 + 3]
seedTenant(slug="qa-dom-<yyyymmdd>-<n>")  + users admin/domain_owner/finance/sales  ON CONFLICT DO NOTHING/UPDATE role

# S2 — fixture E1 via API (idempotente por business key)              [precisa cravo 2]
POST /api/cadastro/pack {pack, why}            # se industry_pack já = pack → skip
POST nodes ×2 / node_capacity / skus / routes / policies   # GET ?code=… antes; existe corrente → skip (não cria versão)
PUT  /api/tenant-settings {confirmed:true}     # só se confirmed_at null
(alçada vem do pack; não chamar PUT alcada salvo caso de teste)

# S3 — verificação
GET /api/a4-readiness → state ok (ou warn), met=need, unlock.new_scenario=true
GET /api/alcada/queue → mode active, limitMi 2
GET /api/tenant-settings → industry_pack=<pack>, policy_kinds do pack
```
**Reset** = criar **novo slug** (S1→S3); tenant antigo fica (RLS isola; audit preservado). Nada de `DELETE`/`TRUNCATE` em prod; nada de UPDATE em `is_current` por SQL.
Local/CI = `docker compose down -v && up` + `migrate` + S1–S3 (aí reset físico é ok).
Saída do script deve imprimir `TENANT_ID`/`USER_ID` por papel (como o `seed.ts`) p/ a Qualidade plugar no banner “Ator”.

### DoD do seed (quando liberado)
- [ ] Rodar S1–S3 2× no mesmo slug → zero versão nova, zero linha nova em cadastro, audit só da 1ª vez
- [ ] E0 (`e5cf…`) intocado: readiness `block 0/4`, alçada `no_policy` antes e depois
- [ ] E1: readiness `ok`, `new_scenario=true`, alçada `active 2`
- [ ] RLS: tenant QA não vê E0 nem vice-versa
- [ ] `npm run gate` verde (seed sem LLM/fetch externo); `INDEX.md` atualizado com o script novo

---

## 5. Cravos abertos pro PO (bloqueiam implementação)
1. **Onde roda o write happy path?** (a) tenant(s) novos de QA `qa-dom-*` no Neon de prod, criados por seed owner, e o `e5cf…` fica **congelado como E0** (empty-tenant do smoke); ou (b) escrever no próprio `e5cf…` (irreversível: só retire, pack não volta a NULL → perde o empty de referência). **Recomendo (a).**
2. **Fixture E1 entra no seed?** (a) script `seed:dom-fixture` grava a fixture mínima §2.2 **pela API**, pack `generic`, `supply_external_in_scope=false`; ou (b) sem fixture — E1 só pelo happy path manual na UI (Qualidade cria na mão a cada retest). **Recomendo (a)** com pack `generic` (outros packs = parâmetro, não default).
3. **Papéis no seed QA:** criar `domain_owner + finance + sales` além do `admin` (via owner; sem RBAC novo no write), ou manter **admin-only** e deixar casos por papel p/ depois? **Recomendo criar os 3** (gate alçada/land/export já dependem de papel).

## 6. Fora deste checklist
- Implementação Express / script de seed / migration (só após os 3 cravos).
- Corpo do contrato Cadastro write (endpoints, payloads, erros) — **Deivid**.
- UX empty/seed e wire do Cadastro (copy, estados vazios, banner Ator) — **Didi**.
- Aceite/E2E — **Qualidade** (T-DOM-QA-CAD) consome §4.
- `sales_history`/A1 CurvaDemanda (Path C), RBAC real, multi-alçada, packs por upload.
