# Wire→live P1 — Pulse + Cadastro (browser → Neon)

Status: **rascunho arch Deivid** · 2026-10-30 · eng: Devi · UX: Didi (só pontos de troca no shell) · **sem migration / sem entidade nova**

## Objetivo
No shell 0.3.9 em `https://ibp-agentic.vercel.app`, trocar **mock in-memory** por `fetch` real só em **Pulse (leitura)** e **Cadastro (leitura + settings/readiness)**. Journey / Execution / Wizard / A4 run / export **continuam mock** nesta fatia.

## Auth (inalterado)
Todo `/api/*` (exceto o que não existe): headers obrigatórios
- `x-tenant-id: <uuid>` — seed demo: `e5cf5324-7a2b-4e95-80c8-fd119b7bede7`
- `x-user-id: <uuid>` — seed admin: `60519ce8-6a2b-4a44-acc8-2e452fe7d1bf`
Sem header → **401** (já é o comportamento). Banner “Ator” do shell → preenche `x-user-id` (não inventar sessão).

Base URL: same-origin `''` (produção) ou origin do host. Sem CORS especial (`CORS_ORIGIN` vazio).

## Rotas live (P1)

### Pulse
| Método | Path | Notas |
|---|---|---|
| GET | `/api/pulse/summary` | Shape W3 já no ar; empty tenant → `planRef.basis=none`, KPIs `null` + `nullReason` |
| GET | `/api/pulse/exceptions` | idem W3 |

### Cadastro / prontidão
| Método | Path | Notas |
|---|---|---|
| GET | `/api/me` | confere tenant/papel |
| GET | `/api/entities` | catálogo de paths |
| GET | `/api/a4-readiness` | readiness; **não** mudar gate nesta fatia (coach B é UX; gate A4 só se PO pedir) |
| GET | `/api/tenant-settings` | labels/currency/uom/confirmed_at |
| GET | `/api/{entity}` | entidades W0: `policies`, `nodes`, `node_capacity`, `routes`, `skus`, `supplier_contracts`, `finance_drivers`, `sales_history` (paths exatos = `entities.ts`) |
| GET | `/api/{entity}/:id` | detalhe |
| GET | `/api/cadastro/packs` | lista packs |

**Fora do P1 (continua mock / não plugar):** `PUT` settings/alcada/pack, `POST` policies, Journey, Execution, scenarios wizard, `POST /api/a4-runs`, export W7, Visões (pode ficar mock; se barato, `GET /api/visoes/:lens` é read-only e pode entrar — opcional Devi).

## O que o shell troca
1. **Pulse:** funções que hoje montam `apiSummary()` / `apiExceptions()` em memória → `fetch('/api/pulse/summary'|'/exceptions', { headers })` → render com o JSON real. Empty = `—` + motivos (já no wire).
2. **Cadastro listas:** telas que leem arrays mock de nodes/skus/… → `GET /api/<path>` com os mesmos headers; tabela vazia ok.
3. **Readiness / settings:** se o coach ou Cadastro lê pack/confirmed mock → `GET /api/a4-readiness` + `GET /api/tenant-settings`.
4. **Flag:** `window.IBP_LIVE = true` (ou query `?live=1`) para rollback rápido ao mock sem redeploy — recomendado.

## DoD
- Com seed headers: Pulse summary **200**, Cadastro `GET /api/nodes` (etc.) **200** (lista vazia ok).
- Sem headers: **401** (não mascarar).
- Shell home continua 0.3.9; chrome não some.
- Journey/Execution CTA seguem mock (copy “demo” ok).
- Qualidade: smoke live + regressão mock flag off.

## Já feito (não reabrir)
- Thin `/ui` → rewrite Vercel `/ui` + `/ui/(.*)` → `/api` **já no ar** (2026-10-30). Stub Cadastro em `/ui?tenant_id=…`.

## Fora
- Auth real, Render/A4 solver, wire→live Journey/Execution, mudar gate readiness pelo coach B.

---
**Implementado (2026-10-30, eng):** overlay no fim do IIFE de `public/index.html` (flag `IBP_LIVE`). Como ligar / headers / rollback: ver `DEPLOY.md` § "Wire→live P1".
