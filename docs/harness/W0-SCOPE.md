# W0 Scope lock

| Área | In | Out |
|------|----|-----|
| Cadastro master data | sim | — |
| Multi-tenant + RLS | sim | — |
| App skeleton | sim | monorepo exagerado |
| Scenario / ditado / A4 / A7 | — | **out** |
| LLM | — | **out** |
| Dashboard caixa (UI) | só se PO liberar pós v0.3 review | default **out** até review |
| Agnóstico indústria | campos genéricos + `attrs`/`body` jsonb | copy/vertical hardcoded |

**Stop rule:** se a tarefa não for W0 ALLOW em `AGENTS.md`, pare e pergunte no Squad (@Deivid @PO).
