# Security guidelines — IBP Agentic V0 (W0)

## Tenancy
- Toda tabela de domínio tem `tenant_id`.
- App seta `app.tenant_id` por request; RLS obrigatório (ver `v0-postgres-cadastro.sql`).
- Nunca confiar só em filtro na aplicação.

## Auth
- Auth fora do banco (ex. Clerk/Auth.js/Supabase Auth) — users espelhados em `users` com role.
- Roles: `domain_owner | sales | supply | finance | admin`.
- Sem secrets no repo; `.env` + vault do ambiente.

## Dados & LLM (W0 quase não usa LLM)
- W0 = cadastro; sem ditado/cenário até review do v0.3.
- Quando LLM entrar: só intent→cartões; nunca mandar PII/contratos integrais sem necessidade; cache de premissas; hard budget configurável.
- Audit trail: decisões e edições de master data; não logar secrets.

## API
- HTTPS only; CORS restrito.
- Validar payloads contra JSON Schema em `contracts/`.
- Rate limit básico na API pública.
- Export de plano (futuro): sem write-back na V0.

## Código
- Sem SQL string concatenada; queries parametrizadas.
- Migrations versionadas (não editar SQL aplicado à mão em prod).
- Dependências pinned; sem instalar pacote não auditado no critical path.
