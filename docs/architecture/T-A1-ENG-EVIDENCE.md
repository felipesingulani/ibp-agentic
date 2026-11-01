# T-A1-ENG — evidence (A1 CurvaDemanda v1, API only)

**Date:** 2026-10-31 (UTC-3) · **Contract:** `A1-CURVA-DEMANDA-CONTRACT.md` (md5 `7e66fe9131c777105553d58891045d71`) · **QA:** `QA-ACCEPTANCE-A1-CURVA.md` M1–M5 / H1–H5
**Name:** the contract (§9) calls this file `T-A1-CURVA-EVIDENCE.md`. The task brief named it `T-A1-ENG-EVIDENCE.md`. Same content.
**Scope:** API + contract + gate + tests + local fixture. **UI not touched** (`public/index.html` not edited by this task; per PO steering, the Dom overlay is being rebased by another task). No git, no Vercel publish, no Neon, no E0 `e5cf5324-…`. Zero migration, zero new endpoint.

## Result
| Check | Result |
|---|---|
| `npm run typecheck` | OK |
| `npm run gate` (src, db, test, contracts, solver, packs) | OK. Rule 11 self-test: `INSERT INTO sales_history` in `src/wizard/` → **FAILED** (exit 1) as expected |
| `npm test` | **161/161 pass** (baseline before A1: 144; +8 integration `a1-curva`, +9 unit `curva`). Log: `T-A1-ENG-test.log` |
| Fixture `seed:a1-fixture qa-a1-20261031-1` (local docker) | OK; 2nd run `none (idempotent)`; slug `e0-x` → refuse |
| Local curl proof | `T-A1-ENG-curl-proof.log` (POST v1 ok 18 pts → 409 duplicate → PATCH recalculates v2 → series from client 400 → PATCH anchor 5m → gap v3 → GET → ditado without LLM 502 `ditado_unavailable`) |

## QA mapping → test
| QA | Test |
|---|---|
| M1 hist→18m, trace = seed, re-run byte-identical, hist read-only | `a1-curva` "M1+H2" (`sales_history` count unchanged; series deepEqual across re-runs: jsonb reorders keys) + unit "determinismo" (byte-identical in the pure function) + gate rule 11 |
| M2 anchor missing / retired / cross-tenant → `invalid_reference`; PATCH → 400 | `a1-curva` "M2", "M4" |
| M3 0m `hist_none`, 5m `hist_insufficient`+`periodsUsed=5`, no anchor `anchor_missing`, `series=[]` | `a1-curva` "M3" + unit "limites" |
| M4 GET `/scenarios/:id` reflects; PATCH recalculates `version+1`/`source=edit`; derived fields → 400 | `a1-curva` "M4", "POST manual v1" + curl |
| M5 tenant isolation + legacy `{growth}` intact + W2/W3/W7/Dom suites | `a1-curva` "M5" + full suite green |
| H1 typed params + 3 profiles | unit "perfis", "params", "contrato JSON" |
| H2 NovaFilial + Curva in the same ditado | `a1-curva` "M1+H2" |
| H3 sales_history ingest unchanged | not touched (`http/app.ts` unchanged); Visões suite green |
| H4 dedupe → `duplicate_curve` (rejected[] in ditado, 409 in POST) | `a1-curva` "H4" + `wizard-api` re-ditado + curl |
| H5 roster A1 off → `a1_disabled` | `a1-curva` "H5" |
| D2 numeric params validated with zod | unit "params"/"cliente" |
| D4 `qa-a1-*` only | `scripts/seed-a1-fixture.ts` (slug regex + E0 guard) |
| D1/D3, HAR/screenshots, Neon counts | **open:** UX (Didi) + Qualidade on deploy |

## Implementation
- `src/wizard/curva.ts` (new): constants; `curvaParamsSchema`/`curvaFieldsSchema` (strict); pure `buildCurva` (window of the 12 most recent closed months, ≥6 → ok, 18 pts starting the month after `histTo`, profiles natural/linear/degrau, qty ≥0 with 2 decimals); IO `loadHist` (SELECT only); roster `assertA1Enabled` (409 `a1_disabled`); `assertNoDuplicateCurve` (409 `duplicate_curve` {cardId,id}); `deriveCurva` (roster → `pg_advisory_xact_lock('pc:'||scenario)` → refs → build/gap → dedupe → safeParse); `parseCurvaClient`/`assertNoDerived`/`mergeCurvaPatch`.
- `src/wizard/cards.ts`: `routeFields(type, fields, status)` (v1 → derived draft; legacy → scalar `fieldsSchema` as before, status required); `insertCard` derives after `nextCardId`; `auditFields` (audit without the series, with `seriesLength`).
- `src/wizard/ditado.ts`: prompt asks for `anchorRef/skuRef` and "NUNCA gere números de série" ("never generate series numbers"); `curvaFromLlm` keeps only params (perfil/rampUpMeses/maturidade/canibalizacao) and drops series/qty from the LLM; resolves refs by code|stable_id; `validateLlmCards` returns `cardIndex`.
- `src/http/scenarios.ts`: ditado loads current SKUs; manual POST via `routeFields`; `rejected[].index` = original LLM index (+ sort).
- `src/http/premise-cards.ts`: POST/PATCH via `routeFields`; PATCH v1 = parse client → merge → `deriveCurva(exceptId)` → version+1, source=edit, audit `why`.
- `contracts/premise-card.schema.json`: `allOf` with a Gap rule + rule `CurvaDemanda ∧ schema=a1.curva.v1 ⇒ $defs/curvaDemandaV1` (ok ⇒ 18 pts, gap ⇒ `[]`, strict).
- `harness/scripts/w2-grep-gate.sh`: rule 11. In `src/wizard/`, INSERT/UPDATE/DELETE/TRUNCATE on `sales_history` → FAIL; ALLOW for `test/integration/a1-curva.test.ts` (wizard routes).
- `scripts/seed-a1-fixture.ts` + `npm run seed:a1-fixture`: tenant `qa-a1-*` via owner (tenant/user/settings only), everything else via API: minimal E1 (unlock), anchors ANC12/ANC05/ANC00 (12/5/0 months up to 2026-09), target node, SKU, scenario "QA A1 curva"; idempotent.

## Decisions / deviations (for Deivid review)
1. **Every** CurvaDemanda from the ditado becomes v1. Legacy (`{growth}`) only via manual POST/PATCH without `schema`. Legacy ignores the roster.
2. Roster `a1_disabled` (409) also applies to **PATCH v1**. The contract only names ditado and POST.
3. Dedupe (anchor, sku, target) also applies to manual POST and PATCH (excluding the card itself). Null tuples count as equal.
4. Manual POST v1 with a top-level `status` → 400 (status is derived).
5. The ditado now sends the tenant's current **SKUs** (code, name) to the LLM so it can resolve `skuRef`. Contract §7 mentions nodes only. Cap of 900 tokens unchanged.
6. The zod schema lives in `curva.ts` (re-exported to `cards.ts` through routing), not literally inside `cards.ts`.
7. Gate changed (rule 11 + ALLOW). Needs Deivid's eyes because it is a harness change.
8. Pre-existing bug fixed: `rejected[].index` in phase 2 pointed at the index within the valid cards, not the LLM's index. Impact: `wizard-api.test.ts` re-ditado now expects `duplicate_curve` at index 1 and `card_id` PC-0001-08 (previously -09).

## Blockers
None. Pending outside eng: UX (Didi: preview/banner/CTA), Qualidade T-A1-CURVA on `qa-a1-*` after the Dom thin ship (publish queue: Dom first).

## md5 (2026-10-31, uncommitted working tree)
```
e61f4b59eac30770219407562b4ada48  src/wizard/curva.ts
19394bf94f5064945b3dcf6b7feb0d69  src/wizard/cards.ts
50aaac233357d4f7aa4d11158d1c4262  src/wizard/ditado.ts
9cb2cb70a3fc76495f71a1f3dc29e16a  src/http/scenarios.ts
47c3dcf1696a739acea85edeec78a965  src/http/premise-cards.ts
13af8f8f03a8b17168f334fa1ecdb214  contracts/premise-card.schema.json
85a70f4ddcb16772cecb188df8b54b5b  harness/scripts/w2-grep-gate.sh
b0696d4e00342a7bb146ddcd1ae56d59  test/integration/a1-curva.test.ts
467b9024df3d11412ed2df0c2c2fae0b  test/unit/curva.test.ts
cbb3ac2fde314383d667f9051b4a2529  test/integration/wizard-api.test.ts
491663cb10e913c205fe7447720b204b  scripts/seed-a1-fixture.ts
dcaa56bda03f0f940b0c111a2957682f  package.json
bb2c13d955e54a4aba5ba02d29295246  docs/architecture/T-A1-ENG-test.log
93b96b121d535dc565064732bb9a06b2  docs/architecture/T-A1-ENG-curl-proof.log
```
- Race fix (2026-10-31): `histCount` em `test/integration/a1-curva.test.ts` L45 escopado ao tenant A (`WHERE tenant_id = $1`); `npm test` paralelo 161/161 — log: `T-A1-ENG-test.log`.
