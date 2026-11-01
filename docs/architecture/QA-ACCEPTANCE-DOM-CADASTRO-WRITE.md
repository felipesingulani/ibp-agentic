# QA aceitação — Dom Cadastro write (wire→live P2)

Status: **READY Qualidade · 2026-10-31** · task **T-DOM-QA-CAD** · base `WIRE-LIVE-P2-CADASTRO-WRITE.md` (md5 `84b5ad47…`) + seed `DOM-CADASTRO-WRITE-SEED-CHECKLIST.md`.
> ✅ **Cravos P2 + seed cravados** (PO): mestres live · ack localStorage · guard client [C1–C3]; happy path `qa-dom-*` · `seed:dom-fixture` · users domain_owner+finance+sales. Execução = pós DoD eng T-DOM-ENG-WRITE + UX T-DOM-UX-SWAP.

Sem implementação. Ambiente: prod/preview do overlay P2 com `?live=1`, **tenant de teste dedicado** (nunca o seed demo `e5cf5324…`) + headers `x-tenant-id`/`x-user-id`.

## DoD (arch §8, citado)
- Com flag + headers: criar/editar/aposentar POL, aplicar pack, PUT settings/confirmed, PUT alçada → **200/201 reais**, refletidos no re-GET e no Neon (audit com `why`).
- Erros da API (400/401/409) aparecem como banner/campo com o código; zero sucesso fingido; zero escrita mock com flag on.
- Checklist §6 completo num tenant vazio → gate "Novo cenário" destrava live.
- Flag off: regressão mock 100 % (smoke embed + coach B iguais ao `b697027d…`).
- Sem endpoint novo, sem migration, sem grant; código fora do overlay byte-idêntico ao wire.

## Must (bloqueia ship)
- [ ] **M1 E2E empty → unlock "Novo cenário" (live, pelo shell)** — tenant vazio:
  1. `GET /api/a4-readiness` → `state=block`, `confirmed=false`, `new_scenario=false`; CTA travado.
  2. Pack `generic` + `why` → 200, `alcadaEffect` em toast, POL alçada `limitMi=2`, `mode=active`.
  3. Config → Confirmar → `PUT /api/tenant-settings {confirmed:true}`; `confirmed_at` vem do **servidor**; re-GET readiness (nada otimista).
  4. **[C1]** Mestres pelo shell: ≥1 `nodes` (node_type ∈ pack) → `node_capacity` (stable_id) · ≥1 `skus` · ≥1 `routes`; `supplier_contracts` só se `supply_external_in_scope`.
  5. ≥1 POL `working_capital` **ou** inventory+service (`polOk`).
  6. Alçada resolvida → readiness ≠ block ∧ confirmed ⇒ `new_scenario=true` ⇒ CTA destrava **sem reload manual**. Wizard segue mock (fora).
- [ ] **M2 Writes reais** — cada rota §3 com flag on: status 200/201, Network mostra `fetch` real com os 2 headers, re-GET reflete, e **zero** escrita em mock/localStorage de Cadastro (exceto `alcada_zero_ack` [C2]).
- [ ] **M3 Audit `why`** — `audit_log` tem linha com `why` em create/update/retire POL, pack e alçada; PATCH POL sem `why` → 400 → banner (não grava).
- [ ] **M4 Erros em banner, nunca sucesso fingido** — 401 (sem `x-user-id`), 400 zod (campo), `409 already_exists`, `409 not_current_version`, `409 alcada_required_in_pack`, `400 use_pack_endpoint`, `400 invalid_pack`: banner/campo com código + `details`; estado da UI inalterado; sem fallback silencioso p/ mock.
- [ ] **M5 Flag off = mock intacto** — sem `?live=1`: zero requests de escrita; smoke Embed Must 1 (`#ref024` span, 0 href) + `#cenarios/novo` empty + coach B idênticos ao `b697027d…`; diff fora do overlay = 0 bytes.

## High
- [ ] **H1 Isolamento** — tenant B não vê nada escrito em A (RLS), em GET e no Neon.
- [ ] **H2 Anti duplo-POST** — botão desabilitado inflight; duplo clique = 1 request; após sucesso cache P1 (`LV.cache`, TTL 5 s) invalidado.
- [ ] **H3 POL business key** — drawer em edição: `name`/`kind` só leitura; "renomear" = nova + `DELETE` antiga (`polRetireReplaced`), ambas auditadas.
- [ ] **H4 Alçada** — `{limitMi:null}` → `misconfigured` → gate travado; `{limitMi:2}` → `active`; `packSwitched` → toast "pack → generic"; `alcMode` lido de `GET /api/tenant-settings`.
- [ ] **H5 [C3] Guard client** — sem `nodes`/`skus` live, publish POL com escopo bloqueia **antes** do POST (mesma copy do mock); nenhum request sai.

## Med
- [ ] **D1 [C2] `alcada_zero_ack`** — persiste em localStorage por tenant+user; **não** altera `alcada.mode` no servidor.
- [ ] **D2** `kind` fora do vocab → 201 + aviso `policy_kind_unknown` visível (não erro).
- [ ] **D3** PUT settings envia só o diff das chaves tocadas (inspecionar payload).
- [ ] **D4** Toasts/copy dos pontos de troca batem com T-DOM-UX-SWAP (Didi).
- [ ] **D5** Fora de escopo seguem mock com flag on: `POST /api/scenarios`, A4 POST, Journey, Execution, decision-events, export W7.

## Evidência
Por item: md5 do HTML testado · HAR/Network (status + headers) · query Neon (`audit_log`, contagens) · screenshot banner/CTA. Resultado GREEN/RED por item no squad.
