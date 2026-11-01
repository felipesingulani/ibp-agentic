# Backlog semana 31/10–06/11 (PO)

## Aberto

| ID | Task | Owner | Status | Notas |
|----|------|-------|--------|-------|
| T-EMB-SMOKE | Smoke prod Embed `b697027d` — Must 1 + `#cenarios/novo` empty | Qualidade | done | Embed ship FECHA 2026-10-31 |
| T-DOM-CAD-PREP | Dom prep Cadastro write — contrato + seed checklist | Deivid (contrato) + Devi (seed) | done_cravos | Cravos PO 1=mestres live 2=ack LS 3=guard client |
| T-MED-COLD | Med cold deep-link (thin, wire) | Didi | done_wire_19d6f1ad | Aguarda QA+rebase+publish |
| T-MED-COLD-QA | Retest Med cold `19d6f1ad` | Qualidade | done | GREEN 2026-10-31 |
| T-MED-COLD-SHIP | Cold no mesmo publish Dom | Deivid | shipped_with_08507c7c | QA confirma prod |
| T-DOM-SEED-PROD | seed:dom-fixture em prod qa-dom-* | Deivid via Vercel build | done | slug qa-dom-20261031-prod-1 tenant 2731f7a6… |
| T-LOW-WZ-SAME | Gate same-tenant WZ sem unmount | Didi | done_1f4f3814 | canônico agora |
| T-MED-SCN | Med SCN lista | Didi | done_1f4f3814 | já no canônico (emitScn/upsertWzScn); sem md5 novo |
| T-DOM-ENG-WRITE | lvWrite + overlay Cadastro write live (W3b) | Devi | shipped_prod_08507c7c | Vercel live |
| T-DOM-UX-PACK | CTA Aplicar pack separado Config (use_pack_endpoint) | Didi | done_f9b1ffdf | canônico agora |
| T-DOM-UX-SWAP | Pontos de troca wire (POL name RO, toasts, banners) | Didi | done_8fd04980 | base cold 19d6f1ad |
| T-DOM-QA-CAD | Checklist aceitação Cadastro write + E2E empty | Qualidade | done_prod_green | Dom FECHA 2026-10-31 |

## Path C (depois Embed)

| ID | Task | Owner | Status |
|----|------|-------|--------|
| T-A1-CURVA | A1 hist→CurvaDemanda 18m | TBD | blocked Embed |
| T-A7-LEVE | A7 orchestrator leve (state_machine_only, sem LLM) | Deivid→Devi | contract_ready | A7-ORCHESTRATOR-LEVE-CONTRACT.md |
| T-DM-PERIOD-GRAIN | period YYYY-MM | Devi+Deivid | done_0018_GREEN |
| T-DM-SALESHIST-UQ | UNIQUE+qty+409 | Devi+Deivid | done_0018_GREEN |

## Fechado hoje

| ID | Task | md5/nota |
|----|------|----------|
| T-EMB-REF024 | Thin `#ref024` + rebase live + publish | prod `b697027d` |


## Cravos Dom (2026-10-31)
1. mestres live V0
2. alcada_zero_ack localStorage
3. 409 Express adiado / guard client
Contrato: `docs/architecture/WIRE-LIVE-P2-CADASTRO-WRITE.md`

## Cravos seed (2026-10-31)
1. qa-dom-* only (E0 frozen)
2. seed:dom-fixture via API
3. users domain_owner+finance+sales
Doc: DOM-CADASTRO-WRITE-SEED-CHECKLIST.md

## Cravos A1 (2026-10-31)
1. 18 pts + anchor no card
2. min 6 periodos hist
3. POST ditado
4. premise_cards only
5. Devi eng / Didi UX / Deivid contrato

## Design system (ordem cravada 2026-10-31)
| ID | Task | Owner | Status |
|----|------|-------|--------|
| T-UX-COPY-DIET | tags §/W/API → ⓘ/?dev=1 | Didi | done_81938cae |
| T-DS-TOKENS | tokens tipo/spacing/raio | Didi | done_e6b0ae01 | ship com próximo overlay |
| T-UX-RAIL | rail recolhível SVG | Didi | done_1935c197 | ship com próximo overlay |
| T-UX-HOME | #home boot default | Didi | done_a1a8b7a0 | ship com próximo overlay |
| T-DS-COMPONENTS | button/input/toast/… | Didi | done_7cd8d81e | DS 5/5 pack fechado |
| T-A1-ENG | Eng CurvaDemanda per contrato | Devi | done_published | dpl 2Gzy9zEGeRJw2edGgasbqk4Uh4Pm · 161/161 |
| T-A1-CONTRACT | A1-CURVA-DEMANDA-CONTRACT.md | Deivid | done_7e66fe91 |
| T-A1-SMOKE-PREP | Fixture qa-a1 + harness Must | Qualidade | ready |
| T-A1-CURVA | Seed+harness+UI smoke | Qualidade | FECHA_GREEN | API 2×72/0 · UI 69/0+10/0 · P3 park |
| T-A1-UX-DRAFT | Regen DRAFT sobre DS 5/5 | Didi | done_2132778a |
| T-A1-UX-PLUG | Plug UX overlay | Didi | done_published_b04fef66 | dpl 9hSR8QcDpx5BuhSjnoLgq7f4314p |
| T-A1-UX-P3 | Wire UI→API live (sem mock ditado) | Devi | parked_v0 | sem chave LLM |
| T-DM-PERIOD-GRAIN | sales_history.period só YYYY-MM | Devi+Deivid | ready | agora High |
| T-DM-SALESHIST-UQ | UNIQUE+qty>=0 sales_history | Devi | ready | agora High |
