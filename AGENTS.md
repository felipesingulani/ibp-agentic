# AGENTS.md — IBP Agentic / Domain Rewire OS

Você é o **Devi** (ou qualquer coding agent neste repo). **Antes de qualquer mudança:**

1. Ler **`INDEX.md`** (mapa do repositório)
2. Ler **este `AGENTS.md`**
3. Confirmar que a tarefa está no **ALLOW** da wave atual

## INDEX é obrigatório
- Sempre comece pela leitura de `INDEX.md`.
- Se criar, mover, renomear ou remover **pastas** (ou arquivos de primeira classe na raiz / `src` / `db` / `contracts` / `docs` / `harness` / `test`), **atualize `INDEX.md` no mesmo PR** com uma breve descrição (1 linha).
- Não deixe o INDEX mentir sobre a árvore.

## Fonte da verdade (ordem)
1. `AGENTS.md` + `INDEX.md` + `docs/harness/*`
2. Put spec: `docs/product/2026-10-29-ibp-agentic-domain-rewire-design.md`
3. Contratos: `contracts/`
4. Wires UX aprovados pelo PO em `docs/product/` (v0.2 happy path; v0.3 shell sob review)

Conflito: **harness + contratos > copy de demo no wire > inventar**.

## Wave atual: W0 Foundation ONLY

### ALLOW
- App skeleton (API + UI mínima de cadastro)
- Migrations / `contracts/v0-postgres-cadastro.sql`
- CRUD cadastro: policies, nodes, node_capacity, routes, skus, supplier_contracts, sales_history, finance_drivers, tenant_settings
- Auth stub + `tenant_id` + RLS
- Testes de schema/migration/RLS
- docker compose local
- Manter `INDEX.md` sincronizado

### DENY (sem pedido explícito PO + Arquiteto no Squad)
- Ditado / cenário / wizard 5 telas / A4 solver / A7 / cockpit
- LLM / tokens
- Write-back ERP/CRM
- Solver pago (Gurobi/CPLEX)
- Hardcode de indústria — capacidade genérica em `node_capacity`; vertical = `attrs` / `tenant_settings`
- Novo microserviço / K8s / data lake
- Alterar JSON Schema ou SQL de contrato sem review do Arquiteto (Deivid)
- Expandir escopo “porque o wire mostrou”

## Definition of done W0
- [ ] `docker compose up` + `npm run migrate` limpos
- [ ] Teste RLS (dois tenants, sem vazamento)
- [ ] README atualizado
- [ ] Sem endpoints de cenário/A4/LLM (`npm run gate` OK)
- [ ] `docs/architecture/SECURITY-GUIDELINES.md` respeitado
- [ ] `docs/harness/PR-CHECKLIST.md` preenchido
- [ ] `INDEX.md` reflete a árvore

## Skills / processo
Superpowers: TDD onde couber; plano antes de feature grande; evidência de teste no PR.

## Quem decide
- **Produto / wire:** PO  
- **Arquitetura / contratos / infra:** Deivid  
- **Implementação:** Devi  
- **Orquestração humana:** Felipe (chat)
