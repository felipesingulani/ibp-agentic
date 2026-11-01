# A4 Solver Worker HTTP — contrato eng (Path A · T-A4-SOLVER-WORKER)

**Status: READY FOR ENG — PO cravou A 2026-10-31** (`worker HTTP` + `A4_SOLVER_URL`)  
Autor: Deivid (Arquiteto) · Eng **T-A4-SOLVER-WORKER** (Devi) · Ops/publish envs (Deivid) · QA **T-A4-SOLVER-WORKER** (Qualidade)  
Base: proposta `A4-PYTHON-VERCEL-DEBT-PROPOSAL.md` (md5 `65b93dc4…`) · `src/a4/solve.ts` + `solver/cbc_solve.py` · W1c (`W1-A4-SKELETON.md`, `W1C-OR-TOOLS-DESIGN.md`).

---

## 1. Escopo
- Worker HTTP **thin** (Python 3.11 + OR-Tools CBC pinado) com:
  - `GET /health` → 200 `{ "ok": true }`
  - `POST /v1/solve` → mesmo JSON **stdin/stdout** de `solver/cbc_solve.py` hoje (modelo LP → `SolveResult`)
- Node Vercel (`src/a4/solve.ts`): se `A4_SOLVER_URL` set → HTTP; senão spawn local (`A4_PYTHON` / `.venv` / `python3`) — **dev/CI intacto**.
- Auth worker: header `x-a4-solver-secret: $A4_SOLVER_SECRET` (shared secret).
- Timeout HTTP ≤ **25s** (body + rede). Sem LLM · sem DB · sem tenant no worker.

## 2. Fora / anti-goals
- Bundle Python na função Vercel (opção B) · fixture mentiroso (C) · Gurobi · multi-período · mudar modelo CBC/`model.ts`.
- Migration · UI `public/index.html` · ligar `A7.enabled` · LLM A7 · Med/Low T-DM · P3.
- Worker **não** sobe a API Node inteira (Dockerfile atual do app fica; worker = image separada mínima em `solver/`).

## 3. Contrato HTTP do worker

### `GET /health`
200 `{ "ok": true }` · sem auth.

### `POST /v1/solve`
**Headers:** `content-type: application/json` · `x-a4-solver-secret: <secret>`  
**Body** (= JSON atual do stdin):
```json
{
  "vars": [{ "name": "…", "lb": 0, "ub": null, "obj": 1.0 }],
  "cons": [{ "name": "…", "lb": null, "ub": 10, "coefs": { "var": 1.0 } }],
  "timeLimitMs": 5000
}
```
**200** (= stdout atual):
```json
{ "status": "optimal|feasible|infeasible|unbounded|abnormal|not_solved",
  "objective": 0.0,
  "values": { "var": 1.0 },
  "wallMs": 12 }
```
(`objective`/`values` null/`{}` quando status ∉ optimal|feasible — igual `cbc_solve.py`.)

**Erros worker:**
| HTTP | Quando |
|---|---|
| 401 | secret ausente/errado |
| 400 | JSON inválido / campos faltando |
| 500 | CBC crash / ortools fail (body `{ "error": "…" }` curto) |

## 4. Mudança Node — `src/a4/solve.ts`
1. Se `process.env.A4_SOLVER_URL` (ex. `https://a4-solver.xxx.onrender.com`):
   - `POST ${A4_SOLVER_URL}/v1/solve` com body = `JSON.stringify(model)` + header secret (`A4_SOLVER_SECRET`).
   - Abort/timeout = `model.timeLimitMs + grace` capped em **25000ms**.
   - 200 + JSON válido → `SolveResult` (mesmo type de hoje).
   - Rede / timeout / 5xx / 401 / JSON inválido → `SolverError("solver_unavailable")` (mensagem estável; sem stack/URL no `a4_runs.error` além do prefixo).
2. Senão: spawn local **como hoje** (`solverPython()` + `cbc_solve.py`).
3. **Preflight opcional no POST `/api/a4-runs`:** se `A4_SOLVER_URL` set, `GET ${URL}/health` (timeout 2s) **antes** do INSERT/enqueue; falha → **503** `{ "error": { "code": "solver_unavailable" } }` (não 500 genérico; não cria run). Se unset → comportamento atual (202 + spawn).

`executeRun` / schemas / reasons / API shape: **intocados**.

## 5. Ops / image
- Pasta `solver/`: Dockerfile thin (python:3.11-slim + `pip install ortools==<pin>` + app HTTP mínimo — FastAPI/Flask/stdlib; escolha Devi, 1 file).
- Host V0: **Render Free** (ou Fly shared) — service novo `a4-solver` (não reusar o web Node do `render.yaml` atual).
- Cold start Free aceito (Felipe ciente). Sleep → 503 `solver_unavailable` no preflight / failed no run async.
- Vercel prod: set `A4_SOLVER_URL` + `A4_SOLVER_SECRET` (Deivid no publish). Sem outras envs.

## 6. DoD
**Eng (Devi):**
- [ ] Worker image + `/health` + `/v1/solve` (fixture LP → optimal|feasible)
- [ ] `solve.ts` dual-path + preflight 503
- [ ] Testes: unit HTTP mock (200 / 401 / timeout→`solver_unavailable`) · spawn local regressão · `npm test` green · gate green
- [ ] UI md5 **inalterado**
- [ ] Evidence `docs/architecture/T-A4-SOLVER-WORKER-EVIDENCE.md`

**Ops (Deivid):** deploy worker + set envs Vercel · smoke health 200.

**QA (Qualidade):** checklist `QA-ACCEPTANCE-T-A4-SOLVER-WORKER.md` — Must: health 200 · 1 `POST /api/a4-runs` prod → `feasible|partial` (não ENOENT) · worker down → 503 `solver_unavailable` · regressão A1/A7 evaluate · UI md5 igual.

## 7. Split
1. **Devi** eng (worker + `solve.ts` + testes) → DoD no Squad.
2. **Deivid** review arch + publish worker/envs.
3. **Qualidade** acceptance prod.
4. Próximo sugerido pós-GREEN (fila PO, **não** esta fatia): #3 override `A7.enabled` tenant demo.

## 8. Tamanho
~1–2d eng + ½d ops. Sem migration.
