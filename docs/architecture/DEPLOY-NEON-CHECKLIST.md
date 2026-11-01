# Checklist deploy prep — Neon + Vercel (V0)

Dono: Deivid (Arquiteto) · rascunho 2026-10-30 · **deployed** 2026-10-30 → https://ibp-agentic.vercel.app (Hobby; A4 não roda). Fonte: `DEPLOY.md`, `README.md#migrations`, `db/migrations/0015–0017`, `src/db/migrate.ts`, `vercel.json`.
Regra: **nenhum segredo neste arquivo** (valores só em `/workspace/.secrets/`, fora do repo).

## 1. Pré-requisitos
- [x] **Claim Neon** (Felipe 2026-10-30; claim URL 404 = expected) — Neon instantâneo (neon.new, sem conta). `NEON_CLAIM_URL` presente em `.secrets/neon.env` (arquivo de 2026-10-30 01:35 BRT) ⇒ expira **~2026-11-02 01:35 BRT** (estimativa; pode ser antes se o DB nasceu antes do arquivo). Claim exige conta Neon → **Felipe** (ver §7).
- [ ] `.secrets/neon.env` presente com: `NEON_OWNER_URL`, `NEON_CLAIM_URL`, `MIGRATION_DATABASE_URL`, `APP_DB_USER`, `APP_DB_PASSWORD`, `DATABASE_URL` (verificado só presença).
  - `MIGRATION_DATABASE_URL` = `neondb_owner`, **host direto (sem `-pooler`)**, `sslmode=require` ✅ — obrigatório: o runner usa `pg_advisory_lock` de sessão.
  - `DATABASE_URL` = `ibp_app`, host **pooler**, `sslmode=require` ✅ — ok: tenancy usa `set_config(..., true)` (transaction-local), compatível com PgBouncer transaction mode.
  - `NEON_OWNER_URL` é pooler → **não** usar para migrate.
- [x] **Vercel token OK** — `/workspace/.secrets/vercel.token` presente; CLI `whoami` = felipesingulani-8101 (2026-10-30 ~07:43 BRT).
- [ ] Repo sem `.git` no box → deploy Vercel via CLI (`vercel deploy`), não Git integration.
- [ ] Local verde antes: `npm run typecheck` · `npm test` (142/142) · `npm run gate`.

## 2. Migrate 0001 → 0017 (Neon owner, URL direta)
Runner: `npm run migrate` (`src/db/migrate.ts`): advisory lock → `schema_migrations` → **0001** = `contracts/v0-postgres-cadastro.sql` (Neon vazio ⇒ aplica, não baseline) → `CREATE/ALTER ROLE ibp_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE` → `db/migrations/0002…0017` em ordem lexical, 1 transação cada, idempotente.
- [ ] Ordem esperada no log: 0001, role ibp_app, 0002 rls · 0003 settings · 0004 grants · 0005 · 0006 stable_ids · 0007 · 0008 · 0009 a4_runs · 0010 · 0011 · 0012 decision_events · 0013 · 0014 execution · **0015 journey + `journey_land_tenant`** · **0016 set_config** · **0017 `journey_land_link`** → `migrate OK`.
- [ ] `neondb_owner` precisa de CREATEROLE (padrão Neon) p/ criar `ibp_app`.
- [ ] `SELECT id FROM schema_migrations ORDER BY id;` → 17 linhas (0001…0017).
- [ ] Reexecutar migrate = tudo `already applied` (idempotência; o `buildCommand` roda a cada deploy).
- [ ] Porta 5432 do box **não** alcança Neon → migrate roda no build da Vercel (§5). Sem dump pré possível do box; Neon tem branch/PITR — criar branch `pre-v0` antes se o DB já tiver dado.

## 3. Role / grants / RLS / SECURITY DEFINER — verificar no Neon
Contexto: local o owner `ibp` é superuser/BYPASSRLS; no Neon o owner é `neondb_owner` (**sem garantia de BYPASSRLS** — atributo não herda de `neon_superuser`). 0016/0017 foram feitas para não depender disso.
- [ ] `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('neondb_owner','ibp_app');` → `ibp_app` = `f,f` (obrigatório). Anotar o valor do owner (com ou sem bypass, 0016/0017 têm de funcionar).
- [ ] FORCE RLS em todas as tabelas com `tenant_id`: `SELECT relname FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace AND relrowsecurity AND NOT relforcerowsecurity;` → vazio (exceto `schema_migrations`, sem RLS).
- [ ] Grants `ibp_app` sem DELETE: `SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee='ibp_app' AND privilege_type='DELETE';` → vazio. `ibp_app` sem INSERT em `tenants`/`users`.
- [ ] Funções definer: `SELECT proname, prosecdef, proowner::regrole, proconfig FROM pg_proc WHERE proname IN ('journey_land_tenant','journey_land_link');` → `prosecdef=t`, owner `neondb_owner`, `search_path=public, pg_temp`.
- [ ] EXECUTE só `ibp_app`: `SELECT has_function_privilege('public','journey_land_tenant(uuid,text,text)','EXECUTE'), has_function_privilege('ibp_app','journey_land_link(uuid,uuid,uuid)','EXECUTE');` → `f, t`.
- [ ] **0016** (`journey_land_tenant`): body com `set_config('app.tenant_id', v_t, true)` **antes** dos INSERTs e restaura o lab — prova real = smoke land thin 201 (§6) com owner NOBYPASSRLS.
- [ ] **0017** (`journey_land_link`): lê `users` do alvo sob RLS do alvo e restaura o lab; recusa = `false` (sem motivo) → API `400 invalid_reference` byte-igual.
- [ ] Como `ibp_app` sem `app.tenant_id`: `SELECT count(*) FROM tenants;` → 0 (RLS fail-closed).

## 4. Seed demo (opcional)
- [ ] `npm run seed` (no `buildCommand`): tenant `demo` + admin, idempotente (`ON CONFLICT`) → imprime `TENANT_ID` no **log de build** — anotar para o smoke.
- [ ] `npm run seed:demo-alcada` (opcional, PO): `generic` + POL alçada `limitMi=2`. Sem isso o tenant fica `no_policy` fail-closed. Decidir se entra no `buildCommand` (Felipe/PO).
- [ ] Sem dado de plano: **A4 (solver Python/OR-Tools) não roda em função Node da Vercel** → sem run ⇒ sem plano aprovado.

## 5. Vercel — envs + buildCommand
- [ ] `vercel.json`: `buildCommand: "npm run migrate && npm run seed"`, rewrite `/(.*)` → `/api` (`api/index.ts` exporta o Express).
- [ ] **Build env** (`-b`): `MIGRATION_DATABASE_URL` (owner, direta), `APP_DB_USER=ibp_app`, `APP_DB_PASSWORD`.
- [ ] **Runtime env** (`-e`): `DATABASE_URL` (ibp_app, pooler), `CORS_ORIGIN=` (vazio). **Owner URL nunca no runtime.**
- [ ] Comando (em `DEPLOY.md`) só depois de token + go do Felipe; valores via `set -a; . .secrets/neon.env` — nunca colar em chat/log.
- [ ] Projeto Vercel Hobby: env sensível marcado *Sensitive*; build log sem eco de URL (runner só loga ids).
- [ ] Rollback: `vercel rollback` (app); schema é aditivo — sem down-migration.

## 6. Smoke pós-deploy (`https://<host>`, headers `x-tenant-id=<TENANT_ID>`, `x-user-id=<admin>`)
- [ ] `GET /health` 200 · UI `/?tenant_id=<TENANT_ID>` carrega.
- [ ] RLS: sem `x-tenant-id` → 4xx; tenant aleatório → listas vazias.
- [ ] **Pulse**: `GET /api/pulse/summary` 200, sem KPI inventado (sem run ⇒ `null` + reason). `GET /api/a4-readiness` 200 (+ `policy_kind_unknown` warn se aplicável, nunca block).
- [ ] **Journey land** (prova 0016/0017 no Neon): `POST /api/journey/runs` 201 → snapshot → steps em ordem (fora de ordem → `409 steps_out_of_order`) → conviction → `POST /:id/land {}` como admin → **201 `mode: created`** (tenant thin + admin). Papel sales/supply/finance → `403 forbidden_role`. `{landTenantId: <inexistente>}` e `{landTenantId: <tenant sem vínculo>}` → `400 invalid_reference` **byte-igual**.
  - ⚠️ Conviction grava em `$JOURNEY_EXPORT_DIR` (default `var/journey/…`): FS da Vercel é read-only fora de `/tmp` → setar `JOURNEY_EXPORT_DIR=/tmp/journey` (efêmero) ou aceitar falha conhecida. **Validar antes.**
- [ ] **Export W7**: `GET /api/plans/approved/export?format=json` → esperado **`409 no_approved_plan`** (sem A4 na Vercel); `format=xyz` → 400; sales → 403; `HEAD` → 405 (§8). 200 real só com Render/solver ou plano importado.
- [ ] Logs Vercel sem erro de RLS (`new row violates row-level security`) nem `permission denied for function`.

## 7. Bloqueios conhecidos
- **Claim Neon por e-mail/conta** — só humano (Felipe) faz o claim; agente não cria conta. Sem claim até ~02/11 01:35 BRT ⇒ DB some (recriar + migrate de novo).
- **Vercel token** — OK (`felipesingulani-8101`). Deploy prod 2026-10-30 ~07:48 BRT → https://ibp-agentic.vercel.app
- **Decisões Felipe**: (a) Vercel (sem A4) × Render Free (A4 ok, exige repo Git — box não tem `.git`); (b) `seed:demo-alcada` no build?; (c) host/domínio e quem acessa (auth ainda é header stub — **não** expor publicamente com dado real); (d) conta Neon/Vercel em nome de quem.
- Auth real/RBAC = wave seguinte: deploy V0 é demo, headers stub forjáveis.

## 8. Residual W7 — HEAD no export
- QA (Low): `HEAD /api/plans/approved/export` → 200 sem corpo mas grava audit `export`. Cravo arch: **405 `Allow: GET`** (ou skip audit) — thin.
- [ ] Estado no box (03:57 BRT): `src/http/plans.ts` já tem guarda `r.all(...)` → não-GET = `405 method_not_allowed` + `Allow: GET`; teste `plan-export.test.ts` "HEAD/POST → 405, 0 audit". **Aguarda DoD do Devi + retest Qualidade** antes do deploy.
