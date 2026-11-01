# Task 13 — W7 Export do plano aprovado (contrato arquitetura)

Status: **aprovado Deivid + PO · 2026-10-30** (4 cravos V0 + proteção fórmula CSV) · autor: Deivid (Arquiteto) · wave W7 · implementação: Devi (Task 13) após green Task 12 / W6

## Objetivo V0
Substituto V0 do write-back ERP (fora do plano): o usuário **baixa o plano aprovado** do OS como arquivo e leva para o ERP/planilha por conta própria. Saiu do Task 12 por cravo PO (W6 cravo 3).

- **Só plano aprovado** (`planRef.basis = approved`) — mesma verdade de Pulse/Visões/Journey (`resolvePlanRef`, W3).
- **JSON + CSV**, download como attachment.
- **Números = `a4_runs.plan` cru** (como gravado pelo run A4 W1c) — nada recalculado, nada inventado.
- Read-only: LLM zero, rede zero, sem SaaS novo, **sem write-back ERP**.

Mesmo vocabulário do OS. Postgres RLS.

## Pré-requisitos
- **Task 12 / W6 green** (QA 84/84 · 131/131 · gate ok) + arch OK.
- W3 `resolvePlanRef` (approved > latest_run > none) e W1c `a4_runs.plan` (`PlanOut` em `src/a4/explain.ts`: `objective`, `solverStatus`, `wallMs`, `period`, `totals`, `flows[]`, `local[]`, `unmet[]`, `utilization[]`; + `params`, `reasonCandidates` gravados em `run.ts`).
- Papéis em `users.role` (`domain_owner|sales|supply|finance|admin`) via `Ctx` stub de headers (mesmo de W6).

## Migration
**Nenhuma.** Leitura de `a4_runs` / `decision_events` / `scenarios` / `tenant_settings` (SELECT já concedido) + `INSERT` em `audit_log` (já concedido). Sem tabela, coluna, função ou grant novo → sem dump obrigatório.

## Endpoints (tenant header + RLS)

| Método | Path | Notas |
|--------|------|-------|
| `GET` | `/api/plans/approved/export?format=json\|csv` | Ordem de checagem: sem `x-user-id` → `401` · papel fora da lista (Regra 2) → `403 forbidden_role {required}` · `format` ausente/∉ {`json`,`csv`} → `400 validation_failed {field:"format"}` · `planRef.basis ≠ approved` (`latest_run`/`none`) → **`409 no_approved_plan {basis}`** · OK → `200` attachment. |

- `Content-Disposition: attachment; filename="plan-<scenarioId>-v<scenarioVersion>-<runCode>.<json|csv>"` (só `[A-Za-z0-9._-]`).
- `Content-Type`: `application/json; charset=utf-8` · `text/csv; charset=utf-8` (BOM UTF-8 p/ Excel pt-BR).
- `Cache-Control: no-store`.
- Nenhuma outra rota; nenhuma escrita além do `audit_log`.

## Payload JSON
```json
{
  "exportVersion": "w7.v0",
  "exportedAt": "2026-10-30T06:40:00.000Z",
  "planRef": { "basis": "approved", "scenarioId": "…", "scenarioVersion": 3, "runId": "…", "at": "…" },
  "run": { "runCode": "…", "status": "feasible", "startedAt": "…", "finishedAt": "…" },
  "settings": { "currency": "BRL", "uom": null },
  "plan": { "…": "a4_runs.plan cru, exceto reasonCandidates" }
}
```
`plan` = objeto gravado em `a4_runs.plan` **sem transformação** (mesmas chaves, mesmos números, `null` preservado). Única remoção: `reasonCandidates` (diagnóstico interno do run). `params` fica (rastreabilidade das premissas). `planRef` = saída de `resolvePlanRef` (byte-igual ao `planRef` do Pulse na mesma hora).

## CSV (formato longo, uma tabela)
**Cravo PO 2026-10-30 — proteção de fórmula:** células **texto** cujo valor começa com `=`, `+`, `-` ou `@` recebem prefixo `'` **só no CSV** (JSON continua cru, sem prefixo). Números do `plan` não mudam — só neutraliza interpretação de fórmula no Excel. Thin Task 13 agora ou residual imediato pós-green.

1ª linha = comentário com o `planRef`; 2ª = header de colunas:
```
# exportVersion=w7.v0;basis=approved;scenarioId=…;scenarioVersion=3;runId=…;runCode=…;approvedAt=…;exportedAt=…;currency=BRL;uom=
section,metric,node_id,node_code,route_id,route_code,sku_id,sku_code,qty,used,capacity,pct,value
```

| `section` | origem (`a4_runs.plan`) | colunas preenchidas |
|-----------|-------------------------|---------------------|
| `total` | `objective`, `period`, `solverStatus`, `totals.{demand,served,unmet,fillRate}` | `metric` (= chave, ex. `fillRate`) + `value` |
| `flow` | `flows[]` | `route_id`, `route_code`, `sku_id`, `sku_code`, `qty` |
| `local` | `local[]` | `node_id`, `sku_id`, `qty` |
| `unmet` | `unmet[]` | `node_id`, `sku_id`, `qty` |
| `utilization` | `utilization[]` | `node_id`, `node_code`, `used`, `capacity`, `pct` |

- Separador `,`; decimal `.` (número cru, sem formatação de locale nem arredondamento); RFC 4180 (aspas quando houver `,`/`"`/quebra).
- **`null` / ausente → célula vazia** (nunca `0`, nunca `null` literal).
- Códigos só onde o `plan` já grava (flows: route/sku; utilization: node). `local`/`unmet` saem só com ids — **sem join** pra enriquecer (V0 = cru).
- Ordem: `total` → `flow` → `local` → `unmet` → `utilization`; dentro da seção, ordem do array gravado.

## Regras
1. **Só approved (cravado PO).** Fonte = `resolvePlanRef` W3 (approve da mesma `scenario_version` corrente, run `feasible|partial`). `latest_run`/`none` → `409 no_approved_plan {basis}`; **nunca** cair pro latest_run.
2. **Papéis (cravado PO):** `ctx.role ∈ {admin, domain_owner, finance}` (finance = leitura financeira). Checado antes de qualquer leitura do plano; `403 forbidden_role {required:["admin","domain_owner","finance"]}`. `sales`/`supply` → 403 no V0.
3. **Números crus (cravado PO).** JSON = `a4_runs.plan` como gravado; CSV = projeção 1:1 das mesmas chaves. Zero cálculo novo (nem custo unitário, nem KPI do Pulse), zero default numérico.
4. **Um plano por export.** Exporta o único plano vigente do `planRef` (1 cenário · 1 versão · 1 run). Multi-cenário / histórico = Fora.
5. **Read-only + audit.** Única escrita = 1 linha `audit_log` (`action="export"`, `entity="a4_runs"`, `entity_id=runId`, payload `{format, planRef}`) na mesma tx do SELECT. 4xx não grava audit.
6. **RLS FORCE** — tenant B nunca exporta run de A (`a4_runs` FORCE RLS desde 0009). Sem SELECT cross-tenant, sem SECURITY DEFINER.
7. **LLM zero / rede zero (cravado PO).** Gate **regra 10** (Task 13): `src/plans/` + `src/http/plans*` sem LLM/prompt/narrativa/fetch/ditado, sem cliente de rede (node:http(s)/axios/undici), sem SQL `UPDATE`/`DELETE` e sem `.post/.put/.patch/.delete(` (INSERT só `audit_log` via `audit()` de `http/common.ts`).
8. **Sem arquivo em disco.** Stream da resposta; nada em `var/` (diferente da conviction W5).
9. **Contrato de saída:** opcional `contracts/plan-export.schema.json` (ajv runtime na saída JSON, padrão W4). `a4-run-summary.schema.json` **não** muda.

## DoD
- [ ] `GET /api/plans/approved/export?format=json` → 200 attachment; `plan` deep-equal a `a4_runs.plan` menos `reasonCandidates`; `planRef` = Pulse
- [ ] `format=csv` → 200 attachment; linha `#` com planRef; header de colunas fixo; seções total/flow/local/unmet/utilization; `null` → vazio; números iguais ao JSON
- [ ] `latest_run` (run sem approve) e `none` (tenant vazio) → `409 no_approved_plan {basis}`; nunca exporta latest_run
- [ ] Papéis: admin/domain_owner/finance 200 · sales/supply 403 `forbidden_role` · sem user 401 · `format` inválido 400
- [ ] Aprovação de versão superada (cenário bumpou versão) → 409 (mesma regra `resolvePlanRef`)
- [ ] RLS cross-tenant: tenant B com approve próprio exporta só o seu; sem approve → 409
- [ ] audit_log 1 linha por 200; 0 por 4xx
- [ ] Sem migration; typecheck · testes W0–W7 verdes · gate regra 10 ok · curl evidence `/workspace/backups/w7-task13-curl-evidence.txt`
- [ ] Qualidade: sample-demo com plano aprovado → abrir CSV no Excel/LibreOffice (BOM, acentos, decimal) + matriz papel × basis
- [ ] CSV: células texto com prefixo `= + - @` → prefixo `'` ; JSON sem prefixo; números crus intactos
## Wire (não bloqueia DoD eng)
CTA "Exportar plano (JSON/CSV)" no Pulse / card do plano aprovado = **thin Didi após eng** (cravado PO). Disabled com motivo quando `basis ≠ approved` ou papel fora da lista; mock espelha `409 no_approved_plan` / `403 forbidden_role`.

## Fora
- **HEAD** em `/api/plans/approved/export`: residual QA — `405` ou skip audit (não gravar `export` sem corpo). Thin pós-green.
- **Write-back ERP/TMS** (conector, push, sync, SFTP, webhook) — fora do plano V0. Export = arquivo que o usuário leva.
- Export de `latest_run`, de run específico (`?runId=`), multi-cenário/comparativo, histórico de planos aprovados.
- XLSX/PDF; layout por ERP (SAP/TOTVS); colunas configuráveis; locale `;`/vírgula decimal.
- Enriquecer `local`/`unmet` com códigos/labels; KPIs do Pulse/Visões no arquivo; narrativa/LLM.
- Export assíncrono/agendado/e-mail; storage do arquivo; links assinados.
- RBAC fino (sales/supply lendo export) — revisitar com auth real (Clerk/Auth.js); regra de papel sobrevive à troca.
- Scope filter / abandon da journey (seguem fora desde W6).

## Cravos PO — **cravados 2026-10-30**
1. **Só plano aprovado** (`basis=approved`); senão `409 no_approved_plan`.
2. **JSON + CSV** apenas; números = `a4_runs.plan` cru (nunca inventar).
3. **Papéis:** `admin` + `domain_owner` + **`finance`** (leitura financeira).
4. **Sem rede/ERP;** download attachment. CTA UI no Pulse/plano aprovado = thin Didi após eng (wire, não bloqueia DoD eng).

Decisões de arquitetura (Deivid, dentro dos cravos): CSV formato longo (1 tabela, coluna `section`); 1 plano por export; audit `export`; sem migration; gate regra 10.
5. **CSV fórmula:** células texto `= + - @` → prefixo `'` só no CSV; JSON cru.
