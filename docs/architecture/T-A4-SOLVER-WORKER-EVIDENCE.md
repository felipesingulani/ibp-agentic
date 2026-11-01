# T-A4-SOLVER-WORKER — evidência eng (Devi)

Data: 2026-10-31 (UTC-3) · Contrato `A4-SOLVER-WORKER-CONTRACT.md` md5 `96cbdce77c8152196731a369d7cec7b8` (verificado) · Go Deivid/PO no Squad.
Log bruto: `T-A4-SOLVER-WORKER-TEST-LOG.txt`.

## Resultado
- `npm test` **204/204** (baseline 181 + 23 novos) · `npm run typecheck` 0 · `npm run gate` OK (6 dirs).
- UI `public/index.html` md5 **`2e1fdb610bc2467b8efd16c624333908`** (= prod, intocado).
- **Sem migration** (última segue `0018_…`). `executeRun` / schemas / reasons / shape da API: intocados.
- Zero LLM/DB/tenant no worker. Nada deployado (box-only) — publish worker + envs = Deivid.

## Arquivos
| Arquivo | Mudança |
|---|---|
| `solver/worker.py` (novo) | Worker HTTP stdlib (`ThreadingHTTPServer`, 1 file): `GET /health` → 200 `{"ok":true}` sem auth · `POST /v1/solve` → mesmo JSON do stdout de `cbc_solve.py`; 401 secret ausente/errado (`hmac.compare_digest`) · 400 JSON inválido/campos faltando (`vars`/`cons` arrays, `name`, números/null, coefs só em vars declaradas, `timeLimitMs` int 1..60000, body ≤ 8 MiB) · 500 `{"error":"solver_failed"}` curto · 404 fora das 2 rotas. Porta `$PORT` (default 8080). **Fail-closed:** sem `A4_SOLVER_SECRET` não sobe (exit 2). Log 1 linha/request sem headers/body. |
| `solver/cbc_solve.py` | Núcleo extraído para `solve_model(m) -> dict` (reusado pelo worker). Contrato stdin/stdout **inalterado**; modelo CBC igual. |
| `solver/Dockerfile` + `.dockerignore` (novos) | `python:3.11-slim` + `ortools==9.15.6755` (mesmo pin do venv) + `cbc_solve.py`/`worker.py`, `USER nobody`, `CMD python worker.py`. Image separada; Dockerfile do app intocado. Build local OK (376 MB), smoke container OK. |
| `src/a4/solve.ts` | Dual-path (ver abaixo) + `remoteSolverUrl()` + `remoteSolverHealthy()`; spawn local byte-a-byte igual ao W1c. |
| `src/http/a4-runs.ts` | Preflight 503 no `POST /` (ver abaixo). |
| `harness/scripts/w2-grep-gate.sh` | **Regra 13:** `fetch(` liberado só em `src/a4/solve.ts` (regra 4 bloqueava). Resto igual. ⚠ ver Ambiguidades. |
| `test/unit/a4-solver-remote.test.ts` (11) · `test/unit/a4-solver-worker.test.ts` (8) · `test/integration/a4-solver-worker.test.ts` (4) · `test/support/a4-worker.ts` | Testes novos (abaixo). |
| `INDEX.md` · `.env.example` | Linhas novas (AGENTS: INDEX sincronizado) · `A4_SOLVER_URL=` / `A4_SOLVER_SECRET=` vazios (dev = spawn local). |

## Dual-path + secret (`src/a4/solve.ts`)
- `A4_SOLVER_URL` (trim; barra final removida) **set** → `fetch POST ${URL}/v1/solve`, body `JSON.stringify(model)`, headers `content-type: application/json` + `x-a4-solver-secret: ${A4_SOLVER_SECRET ?? ""}`. `AbortSignal.timeout(min(timeLimitMs + grace(3000), 25000))` cobre conexão + corpo.
  - 200 + JSON com shape `SolveResult` → devolvido (inclui `infeasible`/`not_solved` com `objective:null, values:{}` — `executeRun` trata como hoje).
  - rede / timeout / status ≠ 200 (401, 5xx…) / JSON inválido / shape errado → `SolverError("solver_unavailable")` — mensagem fixa, sem URL/stack/status → `a4_runs.error = "solver_unavailable"`.
- **unset/vazio** → spawn local como W1c (`solverPython()` + `solver/cbc_solve.py`). Dev/CI intactos.
- Secret ausente no Node com URL set → header vazio → worker 401 → `solver_unavailable` (fail-closed).

## Preflight (`POST /api/a4-runs`)
- Se `A4_SOLVER_URL` set: `GET ${URL}/health` (2s) logo após o parse do body e **antes** de abrir transação/SELECT/INSERT. Só passa com 200 `{ok:true}`.
- Falha → **503** `{ "error": { "code": "solver_unavailable" } }` (shape literal do contrato §4.3), nenhum run criado.
- Unset → 202 + spawn como hoje.
- Health OK mas solve falha depois (ex.: secret errado, worker caiu no meio) → 202 e run `failed` com `error: "solver_unavailable"` (async, contrato §5).

## Testes (23 novos)
- **Unit HTTP mock** (`a4-solver-remote`): 200 (POST `/v1/solve`, secret, body = modelo) · 200 infeasible passa adiante · 401 (errado e ausente) · 500/503 · JSON inválido / shape errado · timeout (~200ms com limit 100+grace 100; erro sem URL) · cap 25s · conexão recusada · health (ok / 503 / ok≠true / down / pendurado) · **unset → spawn local CBC real**.
- **Worker real** (`a4-solver-worker`, Python do venv): health · solve fixture → optimal **igual ao stdout de `cbc_solve.py`** · infeasible · 401 ×3 · 400 ×6 + 404 · secret fora do log · fail-closed sem secret · **Node via HTTP ≡ spawn local** no LP do piloto.
- **E2E** (`integration/a4-solver-worker`, Postgres local): worker down → 503 shape + 0 runs · worker real → run `done/partial` (unmet 10) e 1 `POST /v1/solve` no log do worker · secret errado → run `failed` `solver_unavailable` · unset → W1c `done/partial`.
- Regressão: suites W1c/A1/A7/W3–W7 todas verdes (204/204).

## Ops (para Deivid — não executado)
- Worker: `docker build -t a4-solver solver/` · env `A4_SOLVER_SECRET` (obrigatória) · `PORT` (Render injeta) · health path `/health`.
- Render: service novo `a4-solver` (runtime docker, `dockerfilePath: solver/Dockerfile`, `dockerContext: solver`, plan free, `healthCheckPath: /health`, env `A4_SOLVER_SECRET` sync:false). **`render.yaml` não foi alterado** (evitar criar service por sync de blueprint sem o Ops).
- Vercel prod: `A4_SOLVER_URL` (sem barra final ok) + `A4_SOLVER_SECRET` (mesmo valor).

## Ambiguidades / decisões (flag p/ review Deivid)
1. **Gate regra 4** (`fetch(` só em `src/wizard/`) conflitava com o contrato §4 (HTTP a partir de `solve.ts`). Adicionei **regra 13** estreita (só `src/a4/solve.ts`) em vez de usar `node:http` para escapar do grep. Deivid: aprovar/ajustar.
2. **Shape do 503**: segui o contrato literal `{error:{code:"solver_unavailable"}}`; o resto da API usa `{error:"<code>", details}`. Se preferir o padrão da casa, é 1 linha.
3. **Ordem do preflight**: antes de validar cenário/readiness (sem transação aberta durante a chamada de rede). Logo, worker down + cenário inválido → 503 (não 400).
4. Worker **recusa subir** sem secret (fail-closed) em vez de subir e responder 401 a tudo — health não responde nesse caso.
5. Validação 400 do worker é um pouco mais estrita que o `cbc_solve.py` (ex.: `timeLimitMs` int 1..60000; coef em var não declarada). O Node só manda modelos de `buildModel`, que passam.
