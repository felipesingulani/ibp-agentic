# Coach B · delta readiness / gates (arch)

Status: **aprovado Deivid** p/ wire **0.3.10** · 2026-10-30 · design Didi · eng Devi após green QA  
Fonte: `docs/superpowers/specs/2026-10-30-ibp-agentic-ux-coach-b-embed-a-design.md`

## 1. A4 readiness — item `sku` (eng thin)
Hoje `computeReadiness` = policy → node_capacity → route → supplier_contract.  
**Delta:**
- Inserir item `{ key: "sku", entity: "skus", required: true, label: "≥ 1 SKU publicado (Produtos)", … }` com `status ok` ⇔ existe SKU corrente.
- **Ordem canônica dos items:** `node_capacity` → `sku` → `route` → `supplier_contract` → `policy` (consumidores **por `key`**, nunca por índice).
- Exceção Pulse: `EXC-rd-sku` (mesmo shape das outras readiness).
- Facts: carregar `skus` correntes no loader de readiness (sem migration).

Alçada **não** entra em `items` A4 (só coach/`canStart`).

## 2. Gate `canStart` (UX; wire agora)
```
canStart = sample OR (cfg confirmada AND readiness.state ≠ "block" AND alçadaResolvida)
alçadaResolvida = alcMode ∈ {active, no_policy} OR alcAck
```
- `alcada_zero_ack`: **wire** = localStorage (tenant+user); **live** = adiar — candidata `tenant_settings` jsonb (sem migration nesta fatia). Aceite **não** muda `alcada.mode` (segue `misconfigured`).

## 3. `409 scope_requires_masters` (lean A)
- **Wire 0.3.10:** mock OK (bloquear publish; rascunho ok; global 201).
- **API Neon:** `policies` **não** tem coluna `scope` (só `body` jsonb). **Não** plugar 409 na API nesta fatia sem contrato de campo (`body.scope` vs coluna). Quando plugar: se escopo ∉ allowlist global **e** (count nodes=0 **ou** count skus=0) → `409 scope_requires_masters`; validação de ID específico = fase 2.

## 4. Fora
Embed A · mudar grants · migration · gate A4 por alçada.
