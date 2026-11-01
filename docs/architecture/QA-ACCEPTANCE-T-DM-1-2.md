# QA aceitação — T-DM-PERIOD-GRAIN + T-DM-SALESHIST-UQ (opção A V0)

Status: **READY Qualidade · 2026-10-31** · tasks **T-DM-PERIOD-GRAIN** + **T-DM-SALESHIST-UQ** · base backlog Deivid High 1+2 + Go PO opção A + SELECTs limpos.
> ✅ M0 pré-migrate GREEN (`TOTAL_ROWS=34` · `PERIOD_LEN_NE_7=0` · `PERIOD_YM_OK=34` · `DUP_GROUPS=0`). Smoke = pós DoD eng Devi (CHECK+zod+UNIQUE, sem backfill). Sem UI. Fixture `qa-a1-*` / `qa-tdm-*` (nunca E0 `e5cf…`).

## Cravos (PO — CRAVADO 2026-10-31)
1. V0: `period` **só** `YYYY-MM` (CHECK DB + zod `ym`) — rejeita dia.
2. UNIQUE `(tenant_id, node_id, sku_id, period, source)` + `qty >= 0` · **strict** (re-POST → 409; sem upsert V0).
3. Pré-migrate SELECTs limpos (feito) · sem backfill.
4. API path inalterado; A1 pode manter `left(period,7)` inócuo.
5. Med/Low T-DM-* → W0.2 · P3 parked.

## DoD (arch backlog, citado)
- **PERIOD-GRAIN:** CHECK `period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'` · zod idêntico · POST dia/`YYYY-MM-DD` → `400` · seed/fixture só mês.
- **SALESHIST-UQ:** UNIQUE 5-colunas · `qty >= 0` · re-POST mesma chave → `409` (strict; sem upsert V0) · zero dobra em A1/A4 por reimport.
- SELECTs pré: `PERIOD_LEN_NE_7=0` ∧ `DUP_GROUPS=0` (script `scripts/audit-sales-history-period.ts`) **ou** cleanup aprovado + re-audit GREEN antes do migrate.

## Must (bloqueia ship)
- [x] **M0 Pré-migrate audit** — Deivid via build: `TOTAL_ROWS=34` · `PERIOD_LEN_NE_7=0` · `PERIOD_YM_OK=34` · `DUP_GROUPS=0`. Gate aberto · sem backfill.
- [ ] **M1 Period só mês (DB)** — INSERT direto / migrate: `2026-10` OK · `2026-10-15` / `2026-10-01` / `202610` / `2026/10` → CHECK violation. Contagem pós: `length(period)<>7 = 0` e regex mês = 100%.
- [ ] **M2 Period só mês (API)** — `POST /api/sales_history` (1 linha e `{rows:[…]}`): `period=YYYY-MM` → 201; `YYYY-MM-DD` / vazio / `2026-13` → `400 validation_failed` (campo `period`); zero linha gravada no 400.
- [ ] **M3 UNIQUE + qty** — 2ª INSERT mesma `(tenant,node,sku,period,source)` → rejeitada (409 API **ou** unique_violation tratado); `qty=-1` → 400/CHECK; `qty=0` permitido. Source default estável no UNIQUE (`coalesce` alinhado eng/arch).
- [ ] **M4 Regressão A1/A4/W3** — harness A1 M1 (série 18, `left` inócuo) green no fixture; Pulse sales / filtro `period_from`/`period_to` com só `YYYY-MM` coerente; E0 intocado; Dom cold/overlay md5 inalterado (sem UI).

## High
- [ ] **H1 Isolamento** — UNIQUE e CHECK por tenant (RLS); tenant B pode repetir a mesma chave de A.
- [ ] **H2 Batch ingest** — `{rows:[…]}` com 1 linha inválida (dia ou qty&lt;0) → rejeita o batch sem parcial (ou documenta all-or-nothing); com 2 linhas mesma chave no payload → 400/409 sem duplicar.
- [ ] **H3 Reimport strict** — 2ª POST mesma chave → **409** (UNIQUE; sem upsert V0); contagem Neon estável.
- [ ] **H4 Zod ≡ CHECK** — matriz: valores aceitos/rejeitados iguais na borda API e no DB (sem furo onde zod passa e CHECK quebra, ou o contrário, salvo raw SQL só no migrate/seed interno).

## Med
- [ ] **D1** Filter query `period_from`/`period_to` documentado como lexicográfico em `YYYY-MM` (sem cast date).
- [ ] **D2** Audit script versionado + npm script (`audit:sales-history-period`) no DoD eng.
- [ ] **D3** DATA-MODEL.md / data-model.html: `period` deixa de dizer “YYYY-MM ou YYYY-MM-DD”; UNIQUE+qty documentados.
- [ ] **D4** Fixture `qa-tdm-*` ou reuso `qa-a1-*` com só períodos mês; evidência `T-DM-1-2-EVIDENCE.md`.

## Evidência
Log audit pré/pós · md5 migration · curl 201/400/409 · contagens Neon · harness A1 smoke (subset) · GREEN/RED no Squad.

## Fora
P3 wizard→ditado · T-DM Med/Low (capacity one-current, email CI, jsonb shape, …) · period_start+grain V1 · UI.
