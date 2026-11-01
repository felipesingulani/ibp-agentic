# T-DOM-ENG-WRITE — evidência (2026-10-31, box local · sem Vercel publish · sem git)

Contrato: `WIRE-LIVE-P2-CADASTRO-WRITE.md` · Checklist seed: `DOM-CADASTRO-WRITE-SEED-CHECKLIST.md` §4 · QA: `QA-ACCEPTANCE-DOM-CADASTRO-WRITE.md`.

## 1. Artefatos / md5
| item | valor |
|---|---|
| wire base (Didi, final p/ este DoD) | `1f4f3814a828fe6fd52206fd91f8b498` = f9b1ffdf (T-DOM-UX-PACK) + T-LOW-WZ-SAME · snapshot `/workspace/tmp_v0310/shell-0310-wz-same-1f4f3814.html` |
| **`public/index.html` (overlay)** | **`08507c7c87d3bf5cc7b9aef42cb3f3af`** |
| build | `tmp_dom/build.py` = wire 1f4f3814 (assert md5) + hook LIVE_GATE + `p1_head2.js` + `p2.js` + `p1_tail2.js` antes do `})();` final |
| prefixo | idêntico ao wire exceto 1 linha de hook: `let LIVE_GATE=null;` + `canStart=()=>typeof SIM_START==="boolean"?SIM_START:LIVE_GATE?LIVE_GATE():S.sample||(…)` (simStart do QA tem precedência) |
| fixture | `scripts/seed-dom-fixture.ts` · `npm run seed:dom-fixture` |

Histórico de rebase: 8fd04980 → f9b1ffdf → 1f4f3814 (builds intermediários obsoletos: `5eb2737e…`, `13271ede…`).

## 2. O que o overlay P2 faz (flag `?live=1`; flag off = 100% mock)
- `lvWrite(method,path,body,btn)`: headers `x-tenant-id` + `x-user-id`; 1 write inflight por vez; `cadBusy` em todos `[data-lvw]` + botão; invalida cache (`LV.gen++`) e recarrega Cadastro/Pulse/readiness no sucesso; erro → `showCadastroError(code,details)` do wire + linha `Live: METHOD path → status error · details`. Nunca finge sucesso, nunca cai no mock.
- Cobertura live V0: políticas (POST/PATCH/retire), pack (`POST /api/cadastro/pack` só via `#c-packApply` + `#c-packWhy`, `data-live-swap=pack-post`), settings (`#c-save`/`#c-confirm` PUT diff, **nunca** `industry_pack`), alçada (`PUT /api/cadastro/alcada`), mestres nodes/node_capacity/skus/routes/supplier_contracts via CRUD genérico.
- `#c-pack` = só pendente (`data-pack-pending`); `#c-save` com pack pendente ≠ corrente → banner `use_pack_endpoint` (copy do wire), nenhum PUT.
- Cravo 2: `alcada_zero_ack` segue em localStorage. Cravo 3: guard client `scope_requires_masters` (contagens live de nodes/skus antes de POST/PATCH; copy `POL_SCOPE_ERR`).
- Toast `toastLive("alcadaEffect",{action,limitMi,policyId})` do wire após aplicar pack.
- 409 `already_exists` de mestre: copy ajustada (“Já existe nó/SKU… corrente com essa chave”) — a copy do wire é de política (kind+nome).
- Gate Novo cenário: `LIVE_GATE = unlock.new_scenario ∧ alçada live (active|out_of_pack ∨ ack local)`; `window.IBP_LIVE_GATE()` devolve `{unlock,alcMode,…,canStart}`.

## 3. Achado de API (DELETE)
`DELETE /api/<entity>/:id` só casa o **id da versão corrente** (não `stable_id`) → senão `404 not_found_or_not_current`. PATCH aceita id ou stable_id. Overlay corrigido: archive usa `row.id`; `_replaces`/retire resolvem o id corrente via `lvCurId()` (lista fresca). Prova 404 (stable_id) e 204 (row id) em `T-DOM-ENG-WRITE-curl-proof.log`.

## 4. Curl proof (tenant local qa-dom-20261031-2) — `T-DOM-ENG-WRITE-curl-proof.log`
401 `x-user-id required for writes` · 409 `already_exists` (+details.id) · 400 `invalid_node_type` (allowed CD/Filial/Planta) · 201 create · 400 business key imutável · 200 PATCH v2 · 400 `validation_failed` sem why · 404 DELETE stable_id · **204 DELETE row id** · 400 `invalid_limit_mi` · 400 `use_pack_endpoint` · readiness warn.

## 5. Smoke live (browser) — `tmp_dom/live-smoke.mjs` · 26/26 ✓ (tenant vazio novo `qa-dom-20261031-6`, servidor :3100)
A boot live, alçada `no_policy`, LIVE_GATE fechado · B guard escopo (banner, 0 POST) · C Config: pack-post só no botão, `#c-save`+pack pendente → `use_pack_endpoint` sem PUT, toast `alcadaEffect … criada · limiar R$ 2 mi`, alçada active · D nó/capacidade, todos `[data-lvw]` desabilitados no instante do fetch · E 409 banner com error/details, gaveta aberta · F confirm → readiness `new_scenario=true`, LIVE_GATE aberto, `simStart(false|null)` ok · todos os writes com `x-user-id` · 0 erros JS.

Rodar: `BASE=http://localhost:3100 T=<tenant> U=<admin user> node tmp_dom/live-smoke.mjs` (precisa tenant vazio: `npm run seed:dom-fixture -- qa-dom-<data>-<n> --users-only`).

Manual: `http://localhost:3100/?live=1&tenant_id=<T>` + `localStorage.setItem("ibp.live.userId","<U>")`.

## 6. Regressão flag off (wire 1f4f3814 × overlay)
qa-kind 40/40 = 40/40 · qa-w6 37/37 = 37/37 · smoke-journey wire 111/3 vs new 110/4 · smoke-w7 wire 41/1 vs new 40/2. Única diferença: check estático “zero deps / sem fetch” (esperado: overlay live usa `fetch`, igual ao P1 de prod). Falhas comuns (title v0.3.9, CTA 0.2.4, changelog) já existem no wire.

## 7. seed:dom-fixture
```
npm run seed:dom-fixture -- <qa-dom-slug> [--api http://localhost:3000] [--pack generic] [--no-provision] [--users-only] [--dry-run]
```
- Recusa slug fora de `^qa-dom-` e o tenant E0 `e5cf5324-…` (Embed vazio — **nunca mutado**).
- S1 (owner, `MIGRATION_DATABASE_URL`): upsert tenant + `admin|domain-owner|finance|sales@qa-dom.local` + tenant_settings. S0 GETs. S2 via API: pack, nodes QA-CD-01/QA-FIL-01, capacidade, SKU QA-SKU-01, rota QA-RT-01, política working_capital, PUT `{confirmed:true}` se null. S3 asserts readiness/new_scenario/alçada/pack e imprime `TENANT_ID`, `USER_ID_<ROLE>`, URL de smoke.
- Idempotência: run1 8 writes · run2/run3 0 writes (`tmp_dom/seed-run*.log`).
- Fica em `scripts/` (gate W2 proíbe `fetch(` em `src/` fora de wizard).
- **Prod**: só documentado. Requer autorização PO/Deivid + Neon claim (G5) antes de rodar contra prod.

## 8. Gates
`npm run gate` ✓ · `npm run typecheck` ✓ · `tsc --noEmit` do script ✓ · `node --check` nos 2 `<script>` ✓.
