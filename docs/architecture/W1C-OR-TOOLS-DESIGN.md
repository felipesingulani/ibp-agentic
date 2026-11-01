# W1c — A4 OR-Tools mínimo (desenho)

Status: **aprovado Deivid** · pós-DoD W1b · contrato = `W1-A4-SKELETON.md` + `contracts/a4-*.json`

## Escopo
- Solver: OR-Tools CBC (Python ou binding; processo filho, timeout curto).
- Entrada: cadastro current do tenant (nós+`node_capacity`, rotas, políticas, contratos se `supply_external_in_scope`, Gap cards).
- Saída persistida em `a4_runs`: `A4RunSummary` + `A4Reason[]` (top 3) + `countsByKind`. Kind do reason = enum do contrato `a4-reason.schema.json`: `janela`|`capacidade`|`contrato`|`custo`|`outro` (**nunca** `tancagem`). Contagens usam as mesmas chaves.
- Sem LLM, sem wizard, sem write-back, sem Gurobi.

## API
- `POST /api/a4-runs` → cria run (`queued`→`running`→`done|failed`), retorna id.
- `GET /api/a4-runs/:id` → summary + reasons + countsByKind.
- Tenant só via header + RLS (igual readiness).

## Modelo piloto
- Variáveis: fluxo por rota×SKU (SKU limitado no fixture).
- Constraints: capacidade por nó/período (`node_capacity.capacity_per_period`); balanço; política WC/estoque/serviço como soft (penalidade → reason).
- Objetivo: min custo + violações ponderadas (pesos em fixture/config tenant, não hardcode vertical).

## Reasons always-on
Cada reason: `rank`, `kind` (enum do contrato), `summary`, `refs`, `severity`. Top 3 por impacto. Schema = `contracts/a4-reason.schema.json` — W1c não amplia o enum.

## DoD
- [x] Migration `a4_runs` (+ RLS) — `0009_a4_runs.sql` (FORCE RLS, FK composta ao cenário, status `queued` aditivo, grants app)
- [x] Run real em fixture (não mock) · gate passa (W1 gate; W0 gate ainda passa em src/db/test/contracts)
- [x] Explicações batem schema (ajv) · [ ] Qualidade regressa empty/sample + readiness + 1 run happy

## Implementação W1c (Devi, 2026-10-30 01:33)
- Status API `queued|running|done|failed` (+`discarded` do contrato); DB guarda `queued|running|feasible|partial|discarded|failed` e a API expõe `outcome` = `feasible|partial` quando `done`.
- Mapeamento de violações → kind: demanda não atendida / nó ≥95% / nó sem fonte → `capacidade`; rota acima de `max_lead_time_days` e serviço abaixo de `min_fill_rate` → `janela`; contrato abaixo do mínimo/acima do máximo → `contrato`; custo de frete por rota → `custo`; Gap card: `fields.kind` no enum (legado `tancagem` → `capacidade`) senão `outro`.
- Parâmetros vêm de `policies.body` (`min_fill_rate`, `max_lead_time_days`, `weights`) — sem hardcode de vertical; pesos default em `src/a4/model.ts`.
- Piloto: período = último `sales_history.period`, 1 escalão (origem com capacidade → destino com demanda), limites 50 nós / 50 SKUs / 500 rotas.

## Fora desta fatia
`confirmed_at` (entregue em 0010, fatia própria), `policy_kinds` no tenant_settings, export xlsx, W2 wizard.
