# A1 CurvaDemanda — recomendação dos 5 cravos (T-A1)

**Autor:** Deivid (Arquiteto) · **2026-10-31** · Status: **aguarda carimbo PO**  
Base: `QA-ACCEPTANCE-A1-CURVA.md` · Path C · V0 barata.

| # | Cravo | Recomendação |
|---|--------|--------------|
| 1 | Shape série 18m | Array **18 pontos mensais** (`qty` no UoM do pack). Card leva `anchor: { nodeStableId, skuStableId?, periodsUsed }` + série. Wire preview Mês 3/12 = UI; payload canônico = 18. |
| 2 | Mín. hist | ≥ **6** períodos `sales_history` no nó âncora (current) → `status=ok`. Abaixo / sem hist → `status=gap` com código tipado; **zero** série inventada. |
| 3 | Endpoint | Reusa **`POST /api/scenarios/:id/ditado`** (roster A1). Sem `/api/a1/curva` na V0. |
| 4 | Escrita | Só **`premise_cards`** (série no JSON tipado do card). `sales_history` = ingest read-only; sem tabela auxiliar / sem write-back hist. |
| 5 | Owner | Eng **Devi** · UX **Didi** (T-A1-UX-PREP) · contrato eng **Deivid** pós-carimbo · QA **Qualidade** (T-A1-CURVA). Fixture: tenant `qa-a1-*` (E0 intocável). |

**Fora desta fatia:** A7 leve · A4 solver · Journey · Execution · ERP write-back · Pulse WC 18m chart.

**Próximo após carimbo:** Deivid publica contrato eng 1–2p → Devi + Didi em paralelo → Qualidade smoke.
