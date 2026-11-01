# Deploy grátis (sem gastar)

Banco: **Neon Free** (Postgres serverless; local do box não é alcançável da nuvem).
Usar a connection string **com `?sslmode=require`**.

## Env vars
| var | valor |
|---|---|
| `MIGRATION_DATABASE_URL` | string do owner do Neon (`neondb_owner`) — só migrate/seed |
| `APP_DB_USER` | `ibp_app` (role sem BYPASSRLS, criada pelo migrate) |
| `APP_DB_PASSWORD` | senha forte pra `ibp_app` |
| `DATABASE_URL` | `postgres://ibp_app:<APP_DB_PASSWORD>@<host-neon>/<db>?sslmode=require` |
| `CORS_ORIGIN` | vazio |
| `PORT` | Render injeta; local 3000 |

Seed (uma vez, do box): `MIGRATION_DATABASE_URL=... APP_DB_PASSWORD=... npm run migrate && npm run seed`
→ imprime `TENANT_ID=...` → abrir `https://<host>/?tenant_id=<TENANT_ID>`. Tenant nasce **vazio** (cadastro 0%).

## Opção A — Render Free (recomendada: Express long-running + Python OR-Tools)
`Dockerfile` + `render.yaml`. Render exige repo Git (GitHub/GitLab). Free dorme após 15 min (cold start ~1 min).
Boot roda migrate + seed (idempotentes).

## Opção B — Vercel Hobby
`api/index.ts` (exporta o Express app) + `vercel.json` (rewrite tudo → /api).
Deploy do box sem Git: `npx vercel deploy --prod --token $VERCEL_TOKEN` + envs no projeto.
Limite: **A4 runs (solver Python/OR-Tools) não roda** em função Node — cadastro/readiness/UI ok.

## Estado atual (2026-10-30)
- Neon instantâneo (neon.new, sem conta) já criado; credenciais em `/workspace/.secrets/neon.env` (fora do repo).
  **Expira em 72h** se ninguém clicar no `NEON_CLAIM_URL` (claim = grátis, exige conta Neon).
- Porta 5432 do box não chega no Neon → migrate/seed rodam no build da Vercel (`buildCommand`) ou no boot do Docker (Render).
- Deploy Vercel (precisa só de token): ver comando abaixo.

```bash
set -a; . /workspace/.secrets/neon.env; set +a
npx vercel deploy --prod --yes --token "$(cat /workspace/.secrets/vercel.token)" \
  -b MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" -b APP_DB_USER=ibp_app -b APP_DB_PASSWORD="$APP_DB_PASSWORD" \
  -e DATABASE_URL="$DATABASE_URL" -e CORS_ORIGIN=
```

> Vercel Hobby: `Dockerfile`/`render.yaml` ficam no `.vercelignore` pra não virar serviço Container; migrate/seed seguem no `buildCommand` do `vercel.json`.

Na hora do `vercel deploy`, se a CLI detectar **Container**, tire o `Dockerfile` do cwd (ele é só pro Render): `mv Dockerfile /tmp/ && …deploy… && mv /tmp/Dockerfile .`

## Changelog 2026-10-30 — home pública = shell v0.3.9
- `public/index.html` = cópia byte-idêntica do wire congelado da Didi
  (`docs/superpowers/specs/2026-10-30-ibp-agentic-ux-wire-shell-v0.3.9.html`, md5 `8f5dddf9f42d7aa505d4c2d385da47a5`).
  `public/2026-10-30-ibp-agentic-ux-wire-happy-path-v0.2.4.html` junto (links/iframe "Novo cenário" do shell).
- Mock in-browser (localStorage), auth = stub demo do wire; `?tenant_id=` é aceito e ignorado pelo shell. A4/solver intocados.
- `vercel.json`: estático `public/` primeiro; rewrites só `/health`, `/ui`, `/api/(.*)`, `/ui/(.*)` → função `/api` (sem catch-all).
- Express (local/Render): `GET /` serve o mesmo `public/index.html`; stub W0 saiu da home → listas em `/ui?tenant_id=` e `/ui/:entity?tenant_id=`.
  (Na Vercel `/ui` e `/ui/:entity` vão pra função — rewrite exato `/ui`.)

## Thin `/ui`
Rewrite Vercel: `/ui` → `/api` (além de `/ui/(.*)`). Sem tenant ainda mostra o form stub; com `?tenant_id=` lista entidades.

## Wire→live P1 (overlay, shell segue "v0.3.9")
Contrato: `docs/architecture/WIRE-LIVE-P1-PULSE-CADASTRO.md`. Default = **mock** (byte-idêntico ao 0.3.9; backup `public/index.html.bak-0.3.9`).
- Ligar: `https://<host>/?live=1#pulse` (ou `window.IBP_LIVE=true` antes do script). Rollback = tirar `?live=1` (sem redeploy) ou restaurar o `.bak`.
- Live só lê: `/api/pulse/summary`, `/api/pulse/exceptions`, `/api/me`, `/api/entities`, `/api/a4-readiness`, `/api/tenant-settings`, `/api/cadastro/packs`, `/api/{entity}`, `/api/{entity}/:id`.
  Journey, Execução, cenários/wizard, A4 POST, export W7, PUT settings/alçada/pack, POST policies seguem **mock**.
- Headers (base same-origin): `x-tenant-id` = seed `e5cf5324-7a2b-4e95-80c8-fd119b7bede7` (override `?tenant_id=<uuid>` ou `window.IBP_TENANT_ID`);
  `x-user-id` = seed admin `60519ce8-6a2b-4a44-acc8-2e452fe7d1bf` (override `window.IBP_USER_ID` ou `localStorage["ibp.live.userId"]`; o ator `ibp.journey.actor` é papel, não UUID).
- 401/erro → alerta na UI, nunca sucesso fake. Gate de prontidão/A4 inalterado (só a fonte de dado do card muda).
- Smoke: `curl -s -H 'x-tenant-id: e5cf5324-7a2b-4e95-80c8-fd119b7bede7' -H 'x-user-id: 60519ce8-6a2b-4a44-acc8-2e452fe7d1bf' https://ibp-agentic.vercel.app/api/pulse/summary` (sem headers → 401).
