# Harness V0 — contrato

**Status:** V0 (L0–L3). L4 fica para depois.  
Autor: harness sobre o gate já existente (`harness/scripts/w2-grep-gate.sh`, `npm run gate`).  
Não altera JSON Schema nem SQL de `contracts/`. Não faz deploy.

Camadas desta V0 e o que fica de fora:

| Camada | O que trava | Comando |
|--------|-------------|---------|
| **L0** | typecheck + grep gate + INDEX + md5 dos pins + `npm test` | `npm run harness:l0` (local) e `.github/workflows/ci.yml` (push/PR) |
| **L1** | md5 golden em `harness/pins.json` | `npm run harness:pins` (também dentro do L0) |
| **L2** | smoke **só GET** S1–S8 contra API no ar | `npm run harness:smoke` |
| **L3** | relatório dos checklists QA + SHA + md5 | `npm run harness:report` |
| **L4** | depois | Playwright, Pact, branch Neon por PR, LLM judge — **fora desta V0** |

L0 não sobe servidor e não chama L2/L3. L2 precisa da API (e do worker, se não houver skip). L3 só lê arquivos e o git.

## L0

Ordem fixa (o workflow repete os mesmos cinco passos, separados):

1. `npm run typecheck` — `tsc --noEmit` (`tsconfig.json` inclui `src`, `test`, `scripts`)
2. `npm run gate` — `harness/scripts/w2-grep-gate.sh` em `src db test contracts solver packs`
3. `npm run index:check` — `INDEX.md` e `AGENTS.md` presentes
4. `npm run harness:pins` — L1
5. `npm test` — suíte Node (`tsx --test`), Postgres acessível por `DATABASE_URL` / `MIGRATION_DATABASE_URL`

CI (`.github/workflows/ci.yml`): Node 22 (o glob de `npm test` é expandido nesse runtime), Postgres 16 (`ibp` / `ibp_dev_only` / `ibp_v0`), role `ibp_app` criada pelo migrate que os testes já disparam. O spawn local do A4 usa `solver/.venv` com `ortools==9.15.6755` (mesmo pin da image do worker). Sem `A4_SOLVER_URL` no CI — caminho local, como dev.

## L1 — pins

`harness/pins.json` lista path + md5 (32 hex, bytes do arquivo, igual `md5sum`):

- `public/index.html` — UI pinada `2e1fdb610bc2467b8efd16c624333908` (A7 plug; não mudar a UI para “passar” o pin)
- `contracts/*.schema.json` — schemas de contrato
- `contracts/v0-postgres-cadastro.sql` — SQL baseline
- `docs/architecture/A4-SOLVER-WORKER-CONTRACT.md` — contrato do worker A4

Arquivo pinado mudou de propósito → atualizar o md5 no mesmo PR e pedir review do Arquiteto se for schema, SQL ou o contrato A4. Divergência sem edição do pin = L0 vermelho.

## L2 — smoke S1–S8 (somente GET)

Base: `HARNESS_BASE_URL` (default `http://127.0.0.1:$PORT`, `PORT` default 3000).  
Tenant seed: `HARNESS_TENANT_ID` (uuid impresso por `npm run seed`). Header `x-tenant-id` só nos passos que declaram o tenant. Nenhum corpo é enviado.

| ID | Pedido | Passa quando |
|----|--------|----------------|
| S1 | `GET /health` | 200 e `ok === true` |
| S2 | `GET /api/me` sem header | 401 |
| S3 | `GET /api/pulse/summary` sem header | 401 |
| S4 | `GET /api/a4-readiness` sem header | 401 |
| S5 | `GET /api/me` com o tenant seed | 200 e `data.tenantId` igual ao header |
| S6 | `GET /api/pulse/summary` com o tenant seed | 200 e `data` objeto |
| S7 | `GET /api/a4-readiness` com o tenant seed | 200 e `data.state` string |
| S8 | `GET /` **e** `GET ${A4_SOLVER_URL}/health` | md5 do corpo de `/` = pin de `public/index.html`; worker 200 e `ok === true` |

S8 e o worker: `A4_SOLVER_URL` vazio falha S8. `HARNESS_SKIP_WORKER=1` registra `worker=skip` e S8 fica só no md5 da UI (dev sem worker). O health do worker não manda `x-a4-solver-secret`.

Stdout acaba com `SMOKE_MD5 <32 hex>`: md5 do JSON canônico `[{id,ok,status,detail}…]` dos oito checks, nessa ordem. Esse hex é o `HARNESS_SMOKE_MD5` do L3.

## L3 — relatório

`npm run harness:report` lê `docs/architecture/QA-ACCEPTANCE*.md` (ordem de path). Checkbox aberto não falha o processo — o checklist nasce `- [ ]`. Imprime, por arquivo, a contagem e cada item aberto, mais:

- `sha` — `git rev-parse HEAD` (40 hex)
- `checklist_md5` — md5 da concatenação dos bytes desses arquivos (igual a `cat` em ordem | `md5sum`)
- `smoke_md5` — `HARNESS_SMOKE_MD5`, ou `-` se o L2 não rodou
- a linha DoD abaixo

## Linha DoD (SHA + md5)

Uma linha, dois campos separados por um espaço, sem outro texto:

```
<sha40> <md5-32>
```

- `<sha40>` — commit sob teste (`git rev-parse HEAD`)
- `<md5-32>` — digest em hex minúsculo do artefato citado na mesma evidência

O L3 emite isso como:

```
DOD <sha40> <checklist_md5>
```

O `smoke_md5` vai na linha de cima (`smoke_md5 <hex>`), não no lugar do checklist: o checklist tem md5 estável sem servidor; o smoke amarra a execução L2.

Exemplo do formato (SHA do `main` de partida deste branch + md5 pinado da UI — ilustra os dois campos, não é o DoD deste arquivo):

```
2bf1f7557b60297d183549e55ad1b38b78a7c982 2e1fdb610bc2467b8efd16c624333908
```

O md5 **deste** arquivo não é escrito dentro dele (a linha mudaria o digest). Conferir o blob commitado com:

```
md5sum docs/architecture/HARNESS.md
```

## Fora do V0

Playwright, Pact, Neon branch por PR, juiz LLM, write-back ERP, solver pago. Não entram neste contrato nem no workflow.
