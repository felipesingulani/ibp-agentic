# QA aceitação — A1 hist→CurvaDemanda 18m (Path C)

Status: **READY Qualidade · 2026-10-31** · task **T-A1-CURVA** · base contrato eng `A1-CURVA-DEMANDA-CONTRACT.md` (md5 `7e66fe91…`) + cravos PO sim×5.
> ✅ Contrato fechado. Smoke = pós DoD eng Devi + UX Didi. **Prioridade #1:** Dom write prod no ping seed `qa-dom-*` (esta fatia não fura a fila).

## Cravos (PO)
1. 18 pts mensais + `anchor` no card · 2. ≥6 hist → ok / abaixo → gap · 3. `POST …/ditado` · 4. só `premise_cards` · 5. eng Devi · UX Didi · contrato Deivid · fixture `qa-a1-*`.

## DoD (contrato §1–§6, citado)
- Ditado + âncora current + ≥6 meses hist → `CurvaDemanda` `fields.schema=a1.curva.v1`, `status=ok`, **18** pts (`qty` UoM), `anchor` + `trace` server-side; LLM **nunca** persiste série.
- 0→`hist_none` · 1–5→`hist_insufficient` · sem âncora→`anchor_missing` · âncora inválida→`rejected invalid_reference` · A1 off→`a1_disabled` · dup→`duplicate_curve`.
- PATCH params → recalcula · derivados (`series`/`trace`/`gapCode`/`status`/`periodsUsed`) enviados pelo cliente = `400` · `sales_history` read-only · **sem** migration / endpoint novo.

## Must (bloqueia ship)
- [ ] **M1 Hist→curva 18m** — fixture ≥6 meses: ditado → card v1 `ok`, `series.length===18`, `qty≥0`, `trace.histSource=sales_history` bate com seed, `anchor.periodsUsed≥6` · zero `INSERT|UPDATE|DELETE sales_history` · série byte-idêntica em re-run (mesmos params).
- [ ] **M2 Âncora** — inexistente / aposentada / cross-tenant → `rejected[] invalid_reference` (zero card); PATCH âncora inválida → `400 invalid_reference`.
- [ ] **M3 Gaps tipados** — 0 meses → `gap`+`hist_none`+`series=[]`; 5 meses → `hist_insufficient`+`periodsUsed=5`+`series=[]`; sem âncora → `anchor_missing` · banner UX com código.
- [ ] **M4 Persistência W2** — `GET /scenarios/:id` reflete card+série; PATCH `rampUpMeses`+`why` → série recalculada, `version+1`, `source=edit`; cliente manda `series` → `400 validation_failed`; sem `/api/a1/*`.
- [ ] **M5 Isolamento + regressão** — tenant B não lê hist/série de A; Embed Must1 + Dom cold `08507c7c…` + W2/W3/W7 green; `CurvaDemanda` legado (sem `schema`) intacto.

## High
- [ ] **H1 Schema** — `perfil`∈natural|linear|degrau · `rampUpMeses` 1–18 · `maturidade` · `canibalizacao` tipados; 3 perfis unit + determinismo.
- [ ] **H2 NovaFilial+Curva** — ditado misto gera ambos quando roster permite; Gap ≠ Curva.
- [ ] **H3 Visões Sales** — `sales_history` ingest intocado; lente Sales coerente.
- [ ] **H4 Dedupe** — re-ditado mesma âncora/sku/alvo → `duplicate_curve`; CTA disabled inflight.
- [ ] **H5 Roster** — A1 off → `a1_disabled` (ditado rejected / POST manual `409`).

## Med
- [ ] **D1** Preview Mês 3/12 = `series[2]`/`[11]` + hint 18m.
- [ ] **D2** Params numéricos validados (zod).
- [ ] **D3** `502 ditado_unavailable` copy.
- [ ] **D4** Só `qa-a1-*`; E0 `e5cf…` intocado; evidência `T-A1-CURVA-EVIDENCE.md`.

## Evidência
md5 API/overlay · HAR · Neon (`sales_history` count estável, `premise_cards`, `audit_log`) · screenshots gap/ok · unit+integration log. GREEN/RED no Squad.

## Fora
T-A7-LEVE · A4 lê curva · Journey/Execution/ERP · Dom writes (fila #1).
