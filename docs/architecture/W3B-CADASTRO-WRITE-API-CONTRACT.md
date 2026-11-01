# Task 9 — W3b Cadastro write API: pack + alçada em `tenant_settings` (contrato arquitetura)

Status: **aprovado Deivid + PO · eng Task 9 (2026-10-30)** · wire alvo: shell **v0.3.5** (Cadastro · labels/packs; Didi) + alçada (B) do **v0.3.4/0.2.3** · implementação: Devi (depois do green Task 8) · base: `INDUSTRY-TENANT-PROFILE-DRAFT.md`



## Cravos PO (2026-10-30)
1. `industry_pack=NULL` ≡ **generic** → fail-closed.
2. `generic_no_alcada` = **pack real** → modo `out_of_pack` (único fail-open).
3. limpar alçada = `limitMi:null` (misconfigured); **409** `alcada_required_in_pack` se retirar a última POL em pack que exige alçada.

## Objetivo V0
Tirar do `localStorage` do wire e gravar **no servidor**, por tenant: **pack de indústria** (`profile_id`), **labels** de entidade, **`policy_kinds`** (aliases), **roster A1–A7** e o **limiar da alçada Finance** (POL `kind=alcada`, `body.limitMi`). O que a Task 8 lê (fila, gate, Pulse) passa a respeitar o invariante cravado:

> **fail-open ⇔ o pack do tenant não inclui alçada (POL-04).** Pack com alçada e sem limiar ≡ alçada `0` → **fail-closed**.

Sem LLM, sem solver, sem RBAC real. Código lê **só do tenant**; o pack é **seed** aplicado na escrita (nunca lido em runtime).

## Pré-requisitos
- **Task 8** green: `src/w3/alcada.ts` (`resolveAlcadaPolicy`, `requiresFinance`), `GET /api/alcada/queue`, DecisionEvent v0.2 no `audit_log.payload`.
- CRUD versionado de `policies` já existe (`POST /api/policies`, `PATCH /:id` = nova versão, `DELETE /:id` = retire; `why` obrigatório) — **reusado**, não duplicado.
- `PUT /api/tenant-settings` (0003/0008/0010) já faz upsert parcial com audit.
- **Grants: nenhum novo.** `ibp_app` já tem `SELECT, INSERT, UPDATE` em `tenant_settings` e `policies` (0004) e `SELECT, INSERT` em `audit_log`. Pedir grant novo = escopo errado → volta pro Deivid.

## Migration `0013_tenant_industry_profile.sql` (aditiva, mínima)
Só colunas em `tenant_settings` (1 linha/tenant; FORCE RLS + policy `tenant_isolation_tenant_settings` da 0003 intactas):

```sql
ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS industry_pack text NULL,                       -- profile_id; NULL = legado (≡ generic, ver cravo 1)
  ADD COLUMN IF NOT EXISTS entity_labels jsonb NOT NULL DEFAULT '{}',     -- {node,capacity,route,sku,contract[,capacity_uom]}
  ADD COLUMN IF NOT EXISTS policy_kinds  jsonb NOT NULL DEFAULT '{}',     -- {working_capital[],inventory[],service[],alcada?[]}
  ADD COLUMN IF NOT EXISTS agent_roster  jsonb NOT NULL DEFAULT '{}';     -- {A1..A7:{enabled,...}}
ALTER TABLE tenant_settings
  ADD CONSTRAINT tenant_settings_pack_nonempty CHECK (industry_pack IS NULL OR length(btrim(industry_pack)) > 0),
  ADD CONSTRAINT tenant_settings_jsonb_objects CHECK (jsonb_typeof(entity_labels) = 'object'
    AND jsonb_typeof(policy_kinds) = 'object' AND jsonb_typeof(agent_roster) = 'object');
```
- Sem enum de pack no banco (packs crescem sem migration; API valida contra o registry de `packs/`). Sem grant, sem tabela nova, sem trigger.
- `kpi_labels` (0003), `uom`, `node_types`, `currency` **já existem** e são reusados pelo apply do pack.
- **“Pack inclui alçada”** não ganha coluna: é `policy_kinds ? 'alcada'` (chave presente com ≥1 alias). Uma fonte de verdade; `generic_no_alcada` = pack cujo `policy_kinds` não tem `alcada`.

## Packs (seed no repo, lidos só na escrita)
`packs/<id>/profile.json` — formato do draft industry + bloco de alçada:
```json
{ "profile_id": "oilgas", "name": "Óleo & gás (distribuição)", "sim": false,
  "labels": { "node": "Terminal", "capacity": "tancagem", "route": "Modal", "sku": "Produto", "contract": "Contrato de suprimento", "capacity_uom": "m³" },
  "uom": "L", "node_types": ["Terminal", "Base", "Refinaria"],
  "kpi_labels": { "svc": "Nível de serviço", "wcp": "DIO", "wc": "Capital de giro", "cost": "Custo logístico", "viol": "Violações de política" },
  "policy_kinds": { "working_capital": ["…"], "inventory": ["…"], "service": ["…"], "alcada": ["alcada", "alcada_finance"] },
  "alcada": { "defaultLimitMi": 2, "name": "Alçada Finance investimento" },
  "agents": { "A1": {"enabled": true}, "A2": {"enabled": true}, "A3": {"enabled": true}, "A4": {"enabled": true, "solver": "cbc"},
              "A5": {"enabled": false}, "A6": {"enabled": true}, "A7": {"enabled": false, "mode": "state_machine_only"} } }
```
V0 = 5 arquivos espelhando o `PACKS` do wire 0.3.5: `generic`, `oilgas`, `cpg`, `retail` (todos com `alcada`, default **2**) e `generic_no_alcada` (sem chave `alcada` em `policy_kinds`, sem bloco `alcada`). Gênero gramatical (`g`) e copy ficam na UI (não é contrato).

## Endpoints (tenant via `x-tenant-id` + RLS; `x-user-id` obrigatório nas escritas, stub)
Arquivo novo: `src/http/cadastro.ts` + `src/cadastro/*` (**não** `http/alcada*` nem `src/w3/` — a regra 6 do gate proíbe escrita ali, e continua proibindo).

| Método | Path | Notas |
|--------|------|--------|
| `GET` | `/api/cadastro/packs` | Lista do registry: `{ id, name, sim, includesAlcada, alcadaDefaultMi\|null, labels, policy_kinds, agents }`. Só leitura do repo; sem DB. |
| `GET` | `/api/tenant-settings` | **Estende** a resposta: `industry_pack`, `entity_labels`, `policy_kinds`, `agent_roster` + derivado `alcada: { inPack, mode, policy: {id, version, alcadaMi}\|null }` (mesma função da Task 8). Sem linha → defaults vazios + `industry_pack: null`. |
| `POST` | `/api/cadastro/pack` | **Aplica pack** `{ pack, why }` (`why` ≥1). Uma tx + `pg_advisory_xact_lock(tenant)`. Ver Regras/1–2. `400 invalid_pack` se id fora do registry. Resposta = `GET /api/tenant-settings`. |
| `PUT` | `/api/tenant-settings` | **Estende** o `settingsSchema` (`.strict()` mantido) com overrides parciais: `entity_labels`, `policy_kinds`, `agent_roster` (substituição por chave de topo). **Não** aceita `industry_pack` (troca só via `POST /pack` → `400 use_pack_endpoint`). Validação em Regras/4. |
| `PUT` | `/api/cadastro/alcada` | **Publicar/editar limiar** `{ limitMi: number≥0 \| null, why }`. Upsert da POL de alçada corrente: existe → nova versão (mesma lógica do `PATCH /api/policies/:id`); não existe → cria (`kind = policy_kinds.alcada[0]`, `name` do pack). `limitMi: null` = **limpar** → POL fica, `mode=misconfigured` (fail-closed). Ver Regra 3. |

`DELETE /api/policies/:id` e `PATCH` genérico continuam valendo para POL de alçada, mas passam pelo **mesmo hook** (`src/cadastro/alcada-write.ts`) que o `PUT /api/cadastro/alcada` — uma regra só (Regra 3 e 5).

Wizard/Pulse **não** ganham endpoint: o gate (`POST /api/decision-events` → `403 alcada_finance_required`) e a fila (`GET /api/alcada/queue`) só mudam pela resolução de modo (Regra 6).

## Regras
1. **Trocar pack aplica os defaults do pack** (= `applyPack` do wire): sobrescreve `entity_labels`, `policy_kinds`, `agent_roster`, `kpi_labels`, `uom`; `node_types` = pack ∪ tipos em uso por nós correntes (nunca invalida nó existente); **`currency` intacta**; `confirmed_at` intacto. Overrides anteriores são **descartados** (wire: “descarta overrides”). Audit `update tenant_settings` com `{why, from, to}`.
2. **Alçada × pack na troca** (invariante fail-open ⇔ pack sem alçada):
   | De → Para | Efeito na POL de alçada |
   |---|---|
   | qualquer → pack **com** alçada, sem POL corrente | cria POL com `body.limitMi = alcada.defaultLimitMi` (**2**), `why` da troca (cravado PO: “entra com limiar default do pack”) |
   | qualquer → pack **com** alçada, POL corrente já existe | **mantém** a POL e o limiar do tenant (dado do tenant > seed) |
   | pack com alçada → pack **sem** alçada (`generic_no_alcada`) | **retire** das POLs de alçada correntes (histórico preservado, audit com `why`) → `mode=out_of_pack` |
3. **Publicar alçada em tenant cujo pack não tem alçada** (≡ wire form → `generic`): na mesma tx, `industry_pack ← 'generic'` e `policy_kinds.alcada ← aliases do generic` (resto do config intacto — não re-aplica o pack inteiro); audit registra o switch. Resposta inclui `packSwitched: { from, to: "generic" }` para a UI dar o toast.
4. **Validação (zod, `.strict()`)**:
   - `entity_labels`: exatamente `node, capacity, route, sku, contract` (string 1–40, trim) + opcional `capacity_uom`. Faltando chave → `400 invalid_labels`.
   - `policy_kinds`: chaves ⊂ `working_capital | inventory | service | alcada` (**chaves canônicas fixas**, só aliases mudam); valores = arrays não vazios de string, normalizados com `normalizeKind`; alias repetido entre chaves → `400 ambiguous_policy_kind`. Remover/adicionar `alcada` via `PUT` → `400 use_pack_endpoint` (pack-inclui-alçada só muda por `POST /pack` ou pela Regra 3).
   - `agent_roster`: chaves ⊂ `A1..A7`, `{enabled: boolean}`; `A4.solver` só `"cbc"`; `A7.mode` só `"state_machine_only"` (qualquer outro → `400` — gate de solver pago/LLM continua no código). V0: roster é **config exibida**; **não** liga/desliga endpoints.
   - `limitMi`: `number` finito ≥ 0 ou `null`; string → `400` (o leitor `readMi` da Task 8 continua tolerante para dado legado).
5. **POL de alçada única no V0.** Com pack com alçada: no máximo **1** POL de alçada corrente — o `PUT` faz upsert; `POST /api/policies` com kind de alçada quando já existe → `409 alcada_exists` (use `PUT /api/cadastro/alcada`). `DELETE` da última POL de alçada em pack com alçada → `409 alcada_required_in_pack` (limpar = `limitMi:null`; para tirar a alçada, troque para pack sem alçada). Assim todo item da fila tem `policyRef` (schema da Task 8 intacto).
6. **Resolução de modo (Task 8 ajusta, mesma função p/ fila, gate e Pulse)** — `resolveAlcadaPolicy(policies, policyKinds)`:
   | Situação | `mode` | Efeito |
   |---|---|---|
   | pack sem `policy_kinds.alcada` | `out_of_pack` (**único fail-open**) | fila vazia + aviso “fora do pack”; Sales aprova |
   | pack com alçada, POL sem `limitMi` válido | `misconfigured` (fail-closed) | `alcadaMi=0`; todo Investimento > 0 → Finance |
   | pack com alçada, sem POL corrente (só drift/legado) | `no_policy` → **fail-closed** (≡ 0) | gate bloqueia Sales; fila reporta `notice` + `nextStep=publicar alçada` (ver cravo 3) |
   | limiar válido | `active` | como Task 8 |
   - Kinds de alçada passam a vir de `tenant_settings.policy_kinds.alcada` (sai o `ALCADA_KINDS` hardcoded); `POLICY_KINDS` da prontidão idem para `working_capital/inventory/service`. **Fallback** quando `policy_kinds` = `{}` (tenant legado): vocabulário atual do código **incluindo** `alcada` (≡ generic).
   - Mudar limiar **não** reabre decisões passadas (o `audit_log.payload` v0.2 já guarda `alcadaMi` do momento); a fila recalcula na próxima leitura.
7. **Contratos intactos**: `PremiseCard.type`, `A4Reason.kind`, `DecisionEvent` (enums e v0.2), `AlcadaQueueItem` — **nenhum** muda. Impacto continua `fields.impactMi`; pack só troca o *label* (Capex/WC/…). `mode` é enum de **API** (ganha `out_of_pack`), não de `contracts/`.
8. **RLS + tenant header** como W1–W3: `SET app.tenant_id`, FORCE RLS, sem `SECURITY DEFINER`/`BYPASSRLS`. Escritas sempre com audit (`why` onde houver efeito em política). Tenant B nunca lê/escreve settings/POL de A.
9. **LLM: zero.** Gate ganha **regra 7**: `src/cadastro/` + `http/cadastro.ts` sem LLM/prompt/`fetch(`/ditado; regra 6 (W3 GET-only) segue verde.

## DoD (Devi / Qualidade)
- [ ] `0013` aplica e reaplica (idempotente); W0–W3 verdes; RLS: tenant B não lê/escreve settings nem POL de A
- [ ] `GET /api/cadastro/packs` = 5 packs; `generic_no_alcada.includesAlcada=false`, demais `true` com default 2
- [ ] `POST /pack`: labels/policy_kinds/roster/kpi_labels/uom do seed; `currency` e `confirmed_at` intactos; `node_types` ⊇ tipos em uso; overrides descartados; `400 invalid_pack`; audit com `why`
- [ ] Alçada × pack: →pack com alçada sem POL cria limiar 2 · com POL mantém · →`generic_no_alcada` retira POL → `out_of_pack`
- [ ] `PUT /api/cadastro/alcada`: cria/nova versão; `limitMi:null` → `misconfigured`; em `generic_no_alcada` → `packSwitched` para `generic` + fail-closed na hora
- [ ] Regra 5: `409 alcada_exists`, `409 alcada_required_in_pack`; hook único também no CRUD genérico de `policies`
- [ ] `PUT /api/tenant-settings`: validação de labels/policy_kinds/roster (400s listados); `industry_pack` e chave `alcada` só pelo endpoint de pack
- [ ] Task 8 ajustada: modo `out_of_pack`/`no_policy` closed; `403 alcada_finance_required` em `no_policy` e `misconfigured`; fila valida ajv sem mudar schema; prontidão usa `policy_kinds` do tenant (fallback legado)
- [ ] Gate regra 7 verde; zero grant novo; zero LLM
- [ ] Qualidade: replay do smoke 0.3.5 contra a API — packs, limpar→none(closed), `outofpack`, form→generic, wizard gate, Pulse fila

## Fora
- **W4** (execution pulse write, A6 agente, movimentações × plano)
- **RBAC real** (quem pode trocar pack / publicar alçada = stub de header; Finance-only é regra de UI)
- **Multi-política de alçada** (faixas por escopo/nó/família, múltiplos aprovadores, alçada por moeda) — V0 = 1 POL, 1 limiar
- Roster A1–A7 **efetivo** (ligar/desligar agentes/endpoints) e A5/A6/A7 LLM
- Merge pack ↔ overrides (“re-aplicar pack preservando overrides”), versionamento de pack, packs por upload
- Gênero gramatical/copy de UI, `capacity_uom` com conversão, câmbio
- UI de onboarding/setup além do Cadastro do wire 0.3.5

## Cravos pro PO
1. **Tenant legado (`industry_pack = NULL`) ≡ `generic` → fail-closed.** Muda o `no_policy` fail-open da Task 8 (teste ajusta). Recomendo **sim** (coerente com “sem alçada ≡ 0”).
2. **`generic_no_alcada` vira pack real** (tenant que legitimamente não usa alçada) ou fica só 🧪 sim/QA (`sim:true`, fora da lista default)? Recomendo **real**, rotulado “Genérico sem alçada”.
3. **Limpar alçada = `limitMi:null`** (POL fica, fail-closed) e retire da última POL num pack com alçada → `409`. Alternativa (permitir retire → `no_policy` closed com itens sem POL) exigiria `policyRef` nullable no `AlcadaQueueItem`. Recomendo o `409` (zero mudança de schema).
