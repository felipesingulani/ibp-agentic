# Proposta thin — debt A4 `python3` no Vercel

**Status: PROPOSTA PO (sem eng)** · Deivid · 2026-10-31 ~19:15 America/Sao_Paulo  
**Contexto:** Path C FECHA. Em prod, `POST /api/a4-runs` falha com `spawn python3 ENOENT` (Hobby = função Node; sem interpretador/OR-Tools). Eng local/CI usa `solver/.venv` + `cbc_solve.py`. Bloqueia M3 A7 `auto_policy` commit em prod (sem run `feasible`).

---

## Diagnóstico (1 linha)
Solver A4 = processo filho Python (`src/a4/solve.ts` → `A4_PYTHON` / `solver/.venv/bin/python` / fallback `python3`) + OR-Tools CBC. Runtime Vercel Serverless **não tem** esse binário → ENOENT.

## Opções (V0 barata → escala)

| ID | Opção | Esforço | Custo $ | Risco | Quando |
|---|---|---|---|---|---|
| **A** | **Worker HTTP barato** (Render Free / Fly shared) só `POST /solve` com image Python+OR-Tools; Vercel Node chama com timeout curto + secret | M (eng 1–2d) | ~R$0–15/mês Free→pago mínimo | frio/sleep Free; rede | **Reco V0** |
| **B** | Bundle Python na função (layer / `vercel-python` / dual runtime) | G | Hobby pode estourar size/tempo | frágil no Hobby; cold | evitar V0 |
| **C** | Mock/`fixture_run` em prod quando `A4_SOLVER=off` (grava run fake feasible p/ demo) | P (½d) | 0 | **não é solver real** — só desbloqueia UI/A7 demo | só se PO aceitar “demo mentiroso” |
| **D** | Adiar A4 prod; A7 fica evaluate-only até W0.2 | 0 | 0 | `auto_policy` commit continua SKIP prod | default se A/C não forem agora |

**Reco arch:** **A** (worker thin) + flag `A4_SOLVER_URL` no Vercel. Fallback explícito 503 `solver_unavailable` (já próximo do comportamento atual) se worker down. **C** só se Felipe quiser demo feliz sem solver. **B** fora Hobby. **D** = parked explícito.

## Escopo fatia A (se Go)
1. Image mínima `solver/` (Python 3.11 + ortools pinado) + HTTP `POST /v1/solve` (mesmo JSON stdin/stdout de hoje).
2. `src/a4/solve.ts`: se `A4_SOLVER_URL` set → HTTP; senão spawn local (dev/CI intacto).
3. Auth: header shared secret (`A4_SOLVER_SECRET`) · timeout ≤25s · sem LLM · sem DB no worker.
4. Vercel: só env novas; **sem** migration · UI intocada.
5. **Não** Gurobi · **não** multi-período · **não** mudar modelo CBC.

## Fora
LLM A7 prosa · ligar `A7.enabled` no pack (task à parte, 5 min settings) · Med/Low T-DM · P3 ditado.

## DoD (A)
- [ ] Worker health 200 + 1 solve fixture = optimal/feasible
- [ ] `POST /api/a4-runs` em **prod** → run `feasible|partial` (não ENOENT)
- [ ] 503 `solver_unavailable` se worker down (não 500 genérico)
- [ ] `npm test` + gate green · UI md5 inalterado
- [ ] Qualidade: 1 happy A4 prod + regressão A7 evaluate (commit auto_policy **pode** PASS se fixture+A7 on)
- [ ] Evidência `T-A4-SOLVER-WORKER-EVIDENCE.md`

## DoD (C) — só se cravado
- [ ] Flag `A4_SOLVER=fixture` documentada · run marcado `source=fixture` no plan/audit · UI tag “não aprovado / fixture”
- [ ] Proibido misturar com approve Finance real sem aviso

## Split sugerido
1. PO crava **A / C / D**
2. Deivid contrato 1-pager HTTP (se A) → Devi eng → Deivid publish envs → Qualidade
3. Paralelo opcional (não esta fatia): override `A7.enabled` no tenant demo

## Tamanho
- **A:** ~1–2 dias eng + ½d ops/publish  
- **C:** ~½ dia  
- **D:** 0 (anotar debt)

