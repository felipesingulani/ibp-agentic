# Task 6 — W2 Wizard API (contrato arquitetura)

Status: **aprovado Deivid** · paralelo à 0010 · wire alvo: wizard **v0.2.2+** (Didi)

## Objetivo
Permitir criar/editar cenário + cartões tipados a partir de ditado (LLM barato, só intent→cartões). Sem A7 prose, sem Gurobi, sem write-back.

## Pré-requisitos
- W1c green (`a4-runs`) · Gap/`stable_id` (0007) · readiness
- Unlock Novo cenário (produto): `tenant_settings.confirmed_at IS NOT NULL` **e** `a4_readiness.state ≠ block` (0010). API de cenário **rejeita** create se unlock falhar (`403 scenario_locked` ou `409 a4_not_ready`).

## Endpoints (tenant via header + RLS)
| Método | Path | Notas |
|--------|------|--------|
| `POST` | `/api/scenarios` | body `{name, leg?}` → cria `draft` v1; exige unlock |
| `GET` | `/api/scenarios` | lista current do tenant |
| `GET` | `/api/scenarios/:id` | cenário + cartões |
| `POST` | `/api/scenarios/:id/ditado` | `{text}` → LLM mockável → `PremiseCard[]` (`source=ditado`); **não** persiste sozinho se invalid |
| `POST` | `/api/scenarios/:id/premise_cards` | já existe parcial — alinhar a este contrato; Gap exige `links.nodeId` = stable_id de nó **current** |
| `PATCH` | `/api/premise_cards/:id` | edit tipado (`source=edit`); bump `version` |
| `POST` | `/api/scenarios/:id/a4-runs` | alias opcional; preferir `POST /api/a4-runs` já feito |

## Contratos
- Cartão = `contracts/premise-card.schema.json` (`NovaFilial`\|`CurvaDemanda`\|`Investimento`\|`Gap`).
- Gap sem `nodeId` / nó aposentado / cross-tenant → `400 invalid_reference` (igual W1a).
- `decision-event` **fora** desta task (Task 7).

## LLM
- Só em `POST .../ditado`. Modelo barato + cache por hash(tenant, text).
- Teto: respeitar US$100/mês do squad; timeout curto; se LLM falhar → `502 ditado_unavailable` (UI: erro técnico do wire).
- Testes: **mock obrigatório** (sem rede). Gate W1 atual bloqueia `/ditado` — Task 6 **abre** allowlist só desses paths; Gurobi/LLM prose A7 continuam DENY.

## Grants / migrations
- `GRANT` app em `scenarios` SELECT/INSERT/UPDATE (hoje só SELECT na W1c).
- Sem migration de schema nova se colunas bastam; se unlock 0010 ainda não mergeou, Task 6 depende dela.

## DoD
- [x] Create scenario respeita unlock (`confirmed_at` + readiness ≠ block)
- [x] Ditado → 1+ cartões tipados (mock) · Gap com stable_id
- [x] Edit bump version · audit
- [x] Gate atualizado (allow wizard paths; DENY resto LLM)
- [x] Qualidade: empty unlock · ditado mock · invalid_reference · happy → A4 run

> Entregue 2026-10-30 01:44 (Devi): `src/http/scenarios.ts`, `src/wizard/{cards,ditado}.ts`, migration 0011 (grant), `harness/scripts/w2-grep-gate.sh`, testes `test/integration/wizard-api.test.ts` + `test/unit/ditado.test.ts`. Extras ao contrato: 422 `ditado_no_cards` (nenhum cartão válido) e `rejected[]` na resposta do ditado; sem alias `/scenarios/:id/a4-runs` (usar `POST /api/a4-runs`). Detalhes/residuais: README (API + Gaps).

## Fora
Alçada Finance (Didi B), A7 state machine, Pulse API, export.
