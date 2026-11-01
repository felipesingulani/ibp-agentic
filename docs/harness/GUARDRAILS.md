# Guardrails operacionais (harness)

## Antes de codar
1. Ler `AGENTS.md` e `W0-SCOPE.md`
2. Confirmar que a tarefa está no ALLOW
3. Se a put spec ou wire pedirem cenário: **ignorar na W0** — isso é wave seguinte

## Durante
- Commits pequenos por entidade (nodes, policies, …)
- Não “só mais um endpoint” de cenário
- Capacidade = `node_capacity` (numeric + calendar jsonb); vertical-specific em `attrs`
- Validar inputs; rejeitar payload sem `tenant_id` de contexto

## Gates automáticos (implementar no CI assim que existir repo)
1. `sqlfluff` ou pelo menos `psql -f` migration dry-run
2. Teste RLS (dois tenants, assert isolamento)
3. Grep gate (falha o CI se aparecer):
   - `openai|anthropic|ChatCompletion|langgraph` (W0)
   - `OR-Tools|ortools|gurobi` (W0 — `harness/scripts/w0-grep-gate.sh`, `npm run gate:w0`)
   - W1c: `npm run gate` = `harness/scripts/w1-grep-gate.sh` — CBC open-source permitido (desenho W1c aprovado); segue proibido LLM, `gurobi|cplex`, `/scenarios|/ditado|/optimize`. Varre também `solver/`.
   - rotas `/scenarios`, `/ditado`, `/a4`, `/optimize` (W0)
4. `npm audit` / `pip audit` básico

## Se o agent “alucinar” escopo
Parar → mensagem no Squad: “Fora do W0: &lt;o quê&gt;. Liberar?”
