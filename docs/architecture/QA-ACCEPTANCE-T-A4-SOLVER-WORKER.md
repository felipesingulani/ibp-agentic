# QA aceitação — T-A4-SOLVER-WORKER (worker HTTP + `A4_SOLVER_URL`)

Status: **READY Qualidade · 2026-10-31** · task **T-A4-SOLVER-WORKER** · base `A4-SOLVER-WORKER-CONTRACT.md` (md5 `96cbdce7…`) · PO cravou **A**.
> Smoke = pós DoD eng Devi + publish worker/envs Deivid. Fixture: tenant `qa-a1-*` / `qa-a4-*` (nunca E0 `e5cf…`). UI md5 pré-eng = `2e1fdb61…` (A7 plug) — deve permanecer **igual**.

## Cravos (PO — CRAVADO 2026-10-31)
1. Worker HTTP Python+CBC: `GET /health` · `POST /v1/solve` (= JSON `cbc_solve.py`).
2. Node dual-path: `A4_SOLVER_URL` → HTTP; senão spawn local (dev/CI intacto).
3. Auth `x-a4-solver-secret` · timeout ≤ 25s · preflight 503 `solver_unavailable` se URL set e health falha.
4. Sem migration · UI intocada · sem ligar `A7.enabled` · sem LLM · sem mudar modelo CBC.

## Must (bloqueia ship) — contrato §6
- [ ] **M1 Health worker** — `GET ${A4_SOLVER_URL}/health` → **200** `{ "ok": true }` (sem auth).
- [ ] **M2 Solve prod** — `POST /api/a4-runs` em cenário com modelo válido no tenant QA → run termina **`feasible|partial|optimal`** (status run/`outcome` conforme API atual); **não** `failed` com `spawn python3 ENOENT`.
- [ ] **M3 Preflight down** — com `A4_SOLVER_URL` set e worker inacessível (ou secret errado no path documentado): `POST /api/a4-runs` → **503** `{ error.code: "solver_unavailable" }` · **não** cria run (sem INSERT orphan).
- [ ] **M4 Regressão + anti-escopo** — UI `public/index.html` md5 **igual** pré-eng (`2e1fdb61…`). `POST /api/a7/evaluate` (tenant A7 on) ainda 200 schema `a7.orch.v1` (sem regressão). A1 paths / Pulse readiness green amostral. Zero LLM no worker. E0 intocado.

## High
- [ ] **H1 Auth worker** — `POST /v1/solve` sem secret / secret errado → **401** (direto no worker, se URL pública conhecida).
- [ ] **H2 Body inválido** — worker `POST /v1/solve` JSON inválido → **400**.
- [ ] **H3 Dual-path local** — eng evidence: sem `A4_SOLVER_URL` → spawn local ainda green nos testes (CI).
- [ ] **H4 A7 pós-run** — com run `feasible` no tenant A7 on: `POST /api/a7/evaluate` pode sair de `await_inputs` (amostra `auto_policy|escalate_human` se fixture limpo); commit system amostrável se veredito permitir (não bloqueia M2 se fixture não limpo).

## Med
- [ ] **D1** Evidence `T-A4-SOLVER-WORKER-EVIDENCE.md` + `npm test`/gate green citados.
- [ ] **D2** Cold start Free: 503 `solver_unavailable` documentado (não falso 500).
- [ ] **D3** Timeout/rede → `SolverError("solver_unavailable")` estável (sem stack/URL no `a4_runs.error` além do prefixo).

## Evidência
md5 contrato/UI · worker health · HAR `POST /api/a4-runs` (status run + error) · 503 sample · A7 evaluate pós-run · GREEN/RED no Squad.

## Fora
Opção B/C · Gurobi · migration · UI · `A7.enabled` pack · T-A7-AGENT LLM · Med/Low T-DM · P3.
