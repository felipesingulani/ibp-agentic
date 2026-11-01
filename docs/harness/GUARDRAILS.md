# Guardrails operacionais (harness)

## Harness V0 (L0–L3)

Contrato: `docs/architecture/HARNESS.md`. O CI em `.github/workflows/ci.yml` roda o L0 em push/PR: typecheck, `npm run gate` (`harness/scripts/w2-grep-gate.sh`), `npm run index:check`, `npm run harness:pins`, `npm test` (Postgres).

- L1 trava o md5 da UI (`public/index.html`, `2e1fdb61…`), dos schemas, do SQL baseline e do contrato do worker A4.
- L2 é smoke só GET (S1–S8). Não é passo do CI.
- L3 lê os `QA-ACCEPTANCE*.md` e imprime SHA + md5. Checkbox aberto não falha o L0.
- L4 (Playwright, Pact, Neon branch/PR, LLM judge) não entra nesta V0.

O gate **ativo** é `npm run gate` → `w2-grep-gate.sh`. `gate:w0` / `gate:w1` só imprimem nota histórica.

## Antes de codar
1. Ler `AGENTS.md` e `W0-SCOPE.md`
2. Confirmar que a tarefa está no ALLOW
3. Se a put spec ou wire pedirem cenário: **ignorar na W0** — isso é wave seguinte

## Durante
- Commits pequenos por entidade (nodes, policies, …)
- Não “só mais um endpoint” de cenário
- Capacidade = `node_capacity` (numeric + calendar jsonb); vertical-specific em `attrs`
- Validar inputs; rejeitar payload sem `tenant_id` de contexto

## Gates automáticos
1. L0 no CI (`.github/workflows/ci.yml`): typecheck, grep gate, INDEX, pins md5, `npm test` com Postgres. O migrate dos testes aplica o SQL (não há `sqlfluff` nesta V0).
2. Teste RLS (dois tenants, assert isolamento) — dentro de `npm test`.
3. Grep gate (falha o L0 se aparecer). Histórico W0 em `harness/scripts/w0-grep-gate.sh` (`npm run gate:w0` só avisa). Gate ativo = `w2-grep-gate.sh`:
   - vendor LLM, `gurobi|cplex`, `/optimize` negados
   - CBC / `ortools` no `solver/` é o caminho W1c aprovado (não usar o gate W0 para barrar o CBC)
   - rotas de wizard e marcadores de LLM só nos arquivos do wizard; regras 5–13 no próprio script
4. `npm audit` / `pip audit` básico — fora do L0 V0 (não bloqueia o workflow)

## Se o agent “alucinar” escopo
Parar → mensagem no Squad: “Fora do W0: &lt;o quê&gt;. Liberar?”
