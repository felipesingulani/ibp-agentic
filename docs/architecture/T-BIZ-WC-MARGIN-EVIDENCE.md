# T-BIZ-WC-V0 + T-BIZ-MARGIN-STUB — evidence (fatia 2 + A7 AR-11)

**Date:** 2026-11-01 · **Contract:** `docs/architecture/T-BIZ-ARCH-CONTRACT.md` md5 `53222b6e4297ce65af0c3d2293c82ac3`
**Code SHA:** `1624a4b3265dba5d2d222bbe8ad548c033ad64fa`
**Scope:** AR-01..04, AR-08, AR-10, AR-11. Must M1, M4, M6, M7, M8, M9, M10 (schema `scenario-finance` only). Sem `plan.v1` / `a4-run-plan` (isso é PLAN-UI / M5). Sem migration, sem env nova, sem UI, sem ligar `A7.enabled`.

## Result

| Check | Result |
|---|---|
| `npm test` | **224/224 pass** |
| `npm run gate` | OK (regra 15: teste de finance no ALLOW do wizard) |
| `npx tsc --noEmit` | OK |
| `git diff --stat db/migrations` | vazio |
| UI `public/index.html` | md5 `41d290c95ab3862600148e0b7ec2630f` (inalterado) |
| Env nova | nenhuma (defaults DSO=45, DPO=30, horizonMonths=24, periodDays=30 em `packs/*/profile.json`) |

## Must

| ID | Prova |
|---|---|
| M1 EN-01..05 | `test/unit/scenario-finance.test.ts` — WC 2,70 mi à mão (1000×1500 / 1000×900, DSI 45, DSO 45, DPO 30, set/2026); `no_price` nunca 0; payback `no_payback_in_horizon` e `payback_beyond_horizon`; `capexMi` = `scenarioImpact` (3+0,4); precedência premissa > cadastro > política > `default_pack` |
| M4 EN-06 | `test/integration/scenario-finance.test.ts` — `GET /api/visoes/finance` e pulse: sem run `wc.nullReason=no_plan`; com run válido `wc.value=2.7`, reason ≠ `not_computed_v0` |
| M6 EN-12 | mesmo arquivo — approve grava `audit_log.payload.pack` (`sf.v0`, ΔWC/ΔMC/payback); FD-06 warn + why curto → 400 `gate_warn_min_20` |
| M7 AR-11 | `test/unit/a7-orchestrate.test.ts` — gate block → `await_inputs` `cadastro_gate_block`; ΔMC null → `finance_incomplete`; ΔMC ≤ 0 → `no_margin`; auto só com ΔMC > 0. Integração A7 mantém `auto_policy` quando o baseline vigente tem MC menor |
| M8 | `npm test` 224/224 (A1, A7 evaluate, alçada, export, A4 com venv OR-Tools) + gate |
| M9 | sem diff em `db/migrations`; sem env; UI md5 acima |
| M10 | `contracts/scenario-finance.schema.json` validado por ajv em `loadScenarioFinance` e no teste de integração; listado em `contracts/README.md` e `INDEX.md`. `a4-run-plan` não implementado |

## O que o módulo faz

`src/w3/finance.ts` é a única conta. Volume = `served` (local + flows do run) por SKU. Preço/custo faltante zera o agregado (`null` + `no_price|no_cost` + `missing[]`), nunca soma parcial. DSI sem política → `no_policy` (sem default). DSO/DPO/horizonte/dias caem no bloco `finance` do pack. `capexMi` chama `scenarioImpact`. ΔMC/ΔWC/payback ficam `no_baseline` só quando não há plano aprovado (`resolvePlanRef`); baseline aprovado com MC ou WC null propaga o `nullReason` desse lado. `periodDays` é `{ value, source }`: `YYYY-MM` → dias do mês (`source: period`); período inválido → `period_days` do pack (`source: default_pack`). Run sem `local`/`flows` → `legacy_run`. Rótulos pt-BR em `journey/conviction.ts` (`REASON_PT`).

Pulse e Visões leem `wc.total` desse objeto. `POST /api/decision-events` grava `payload.pack` antes do INSERT. `POST /api/a7/evaluate` lê o mesmo pack: `gates.state=block` espera insumos; ΔMC null ou ≤ 0 não vira `auto_policy`. `package.pack` é o mesmo objeto do audit.

## Fix ARCH RED

Review de arquitetura (AR-01/AR-02) em `src/w3/finance.ts`. Contrato `T-BIZ-ARCH-CONTRACT.md` md5 `53222b6e4297ce65af0c3d2293c82ac3` inalterado. Zero migration, zero env nova. `public/index.html` md5 `41d290c95ab3862600148e0b7ec2630f`.

1. **Baseline incompleto.** Plano vigente com MC ou WC `null` não responde mais `no_baseline`. `deltaMc` / `deltaWc` e o payback que depende deles propagam o `nullReason` do baseline (`no_price`, `no_cost`, `no_policy`, …). `no_baseline` só quando o baseline não existe. `loadCore` guarda o `nullReason` junto do número.
2. **Período inválido.** Fora de `YYYY-MM`, `periodDays.value` é o `period_days` do pack e `periodDays.source` é `default_pack` (mesmo par `{ value, source }` dos outros números). Mês válido usa `source: period` — setembro continua 30, mas a origem não é o pack. O schema `contracts/scenario-finance.schema.json` passou a aceitar esse objeto (`source` enum `period|default_pack`); ajv valida a saída. Pin em `harness/pins.json` atualizado para o md5 novo (`bb2c04435a526d4364a19c13a298130d`).

Testes novos:

- `baseline incompleto propaga o nullReason real; baseline ausente fica no_baseline` — `test/unit/scenario-finance.test.ts`
- `período inválido usa os dias do pack e source default_pack; YYYY-MM usa o mês e source period` — `test/unit/scenario-finance.test.ts`
- `baseline aprovado sem DSI propaga no_policy no ΔWC; sem approve o delta é no_baseline` — `test/integration/scenario-finance.test.ts` (também cobre o fallback `2026-13` no GET, ajv)

`npm run harness:l0` verde. `npm test` **227/227** (antes 224/224, +3).
