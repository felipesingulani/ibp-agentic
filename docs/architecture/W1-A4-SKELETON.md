# W1 — A4 Optimizer (esqueleto arquitetura)

Status: **proposta Deivid** — aguarda cravar do PO no writing-plans.

## Ordem sugerida (não atropelar cadastro)
1. **Residual W0→W1:** `premise_cards.node_id` → `stable_id` (+ FK composta tenant)
2. **Prontidão A4 API:** join `nodes` current + `node_capacity` current (não campo no nó) — ✅ W1b: `GET /api/a4-readiness` (`src/domain/a4Readiness.ts`, migration 0008)
3. **Contrato run:** já em `contracts/a4-*.json` — persistir em `a4_runs` — ✅ W1c: migration 0009 + `POST/GET /api/a4-runs`
4. **Solver:** OR-Tools CBC, escopo piloto (nós/SKUs limitados); reasons top 3 + `countsByKind` — ✅ W1c: `solver/cbc_solve.py` + `src/a4/*`
5. **Sem LLM** nesta wave (ditado fica W2)
6. **Export plano** (xlsx/json); sem write-back

## Critérios de done
- [x] Gap card referencia nó por stable_id (W1 slice 1 — migration 0007 + `/api/premise_cards`)
- [x] Run A4 real (não mock) em fixture de teste (W1c — `test/unit/a4-solver.test.ts`, `test/integration/a4-runs.test.ts`)
- [x] Explicações always-on batem o schema (ajv contra `contracts/a4-*.schema.json`)
- [x] Gate ainda passa (sem LLM) — `npm run gate` = W1 gate (CBC permitido; LLM/Gurobi/CPLEX/ditado proibidos); `npm run gate:w0` ainda passa em src/db/test/contracts
- [ ] Qualidade regressa empty/sample + prontidão

## Fora
Wizard/ditado (W2), A7 prose LLM, Gurobi, K8s.

## Decisões pós-W1b (Deivid)
- **0008** `supply_external_in_scope`: ok.
- **POLICY_KINDS**: provisório ok na W1; mover aliases p/ `tenant_settings.policy_kinds` numa fatia pequena depois (não bloqueia W1c).
- **`confirmed_at`**: ✅ **0010** (`0010_tenant_confirmed_at.sql`; 0009 = `a4_runs`) — PUT tenant-settings `{confirmed}`, helper `unlock` em `/api/a4-readiness` (`timestamptz NULL`); unlock Novo cenário = `confirmed_at IS NOT NULL AND a4_readiness.state ≠ block` — não entra no `state` da readiness.
- Desenho W1c: `W1C-OR-TOOLS-DESIGN.md`.
