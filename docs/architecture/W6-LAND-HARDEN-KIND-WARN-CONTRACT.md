# Task 12 — W6 Harden land + warn de kind (contrato arquitetura)

Status: **aprovado Deivid + PO · 2026-10-30** (4 cravos + ordem steps) · autor: Deivid (Arquiteto) · wave W6 · implementação: Devi (Task 12: **harden land → warn kind → steps_out_of_order**; export **fora**) após green 0016+F-1

## Objetivo V0
Fechar os residuais de segurança/qualidade do W5 + F-1, **sem write-back ERP**, e alinhar a API ao wire **0.3.9** (ordem forçada):

0. **Ordem forçada dos steps** (`POST …/steps/:stepId/complete`): leverage → consensus → roles → conviction; fora de ordem → `409 steps_out_of_order` (hoje a API só exige os 3 antes de conviction).
1. **Harden land** (`POST /api/journey/runs/:id/land`):
   - **checagem de papel** do ator (hoje qualquer `x-user-id` do lab pode dar land);
   - **link só para referência válida** (hoje `landTenantId` aceita qualquer UUID de tenant existente → oráculo de existência `400 invalid_reference` vs `200`).
   - Caminho thin-create (`landTenantId` omitido) **inalterado**: 201 / 409 `land_code_exists` / 400 `land_is_lab` seguem iguais.
2. **Kind fora do vocabulário** (`policies.kind` ∉ `tenant_settings.policy_kinds`) para de ser ignorado em silêncio → **warn no payload** (código + porquê). Não bloqueia.
3. **Export plano aprovado:** **fora do Task 12** (W7/backlog) — cravo PO.

Mesmo vocabulário do OS. Postgres RLS, LLM zero, sem SaaS pago novo.

## Pré-requisitos
- **Task 11 / W5 green** (0015, rotas `/api/journey/runs*`, curl 29/29).
- **0016 green** (`journey_land_tenant` com `set_config('app.tenant_id', …)` antes dos INSERTs; NOBYPASSRLS ok).
- **F-1 green** (`paramsFrom` lê `tenant_settings.policy_kinds` sob RLS; `inKindGroup`) — retest 59/59 · 120/120.
- `:3000` com o código atual (restart pós-0016 feito).

## Migration `0017_journey_land_link.sql` (aditiva, só função)

Necessária porque a validação do link precisa ler `users` do **tenant alvo**, que o app (`ibp_app`, NOBYPASSRLS) não enxerga sob RLS. Sem tabela nova, sem coluna nova, sem grant em tabela.

```sql
-- SECURITY DEFINER, mesmo padrão 0016: valida tudo e devolve resposta UNIFORME (sem oráculo de existência).
CREATE OR REPLACE FUNCTION journey_land_link(p_run_id uuid, p_target uuid, p_actor uuid)
RETURNS boolean   -- true = pode vincular; false = referência inválida (motivo NÃO é exposto)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_lab uuid := app_tenant_id(); v_email text; v_ok boolean;
BEGIN
  IF v_lab IS NULL THEN RAISE EXCEPTION 'journey_land_link: app.tenant_id ausente' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- journey do lab, em conviction, ainda sem land (FOR UPDATE como 0016)
  PERFORM 1 FROM journey_runs j
    WHERE j.id = p_run_id AND j.tenant_id = v_lab AND j.status = 'conviction' AND j.land_tenant_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'journey_land_link: journey não está em conviction no tenant corrente'
    USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_target IS NULL OR p_target = v_lab THEN RETURN false; END IF;      -- land_is_lab já é barrado antes no app
  SELECT u.email INTO v_email FROM users u WHERE u.id = p_actor AND u.tenant_id = v_lab;
  IF v_email IS NULL THEN RETURN false; END IF;
  -- Referência válida = o MESMO ator (mesmo e-mail) é admin no tenant alvo. Leitura sob RLS do alvo e volta ao lab.
  PERFORM set_config('app.tenant_id', p_target::text, true);
  SELECT EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = p_target AND lower(u.email) = lower(v_email) AND u.role = 'admin')
    INTO v_ok;
  PERFORM set_config('app.tenant_id', v_lab::text, true);
  RETURN coalesce(v_ok, false);
END $$;
REVOKE ALL ON FUNCTION journey_land_link(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION journey_land_link(uuid, uuid, uuid) TO ibp_app;
```

`journey_land_tenant` (0016) **não muda**. Dump pré-0017 obrigatório (padrão `ibp_v0-pre-0017-YYYYMMDD-HHMM.dump`).

## Endpoints / mudanças de comportamento

| Método | Path | Hoje (W5) | W6 |
|--------|------|-----------|----|
| `POST` | `/api/journey/runs/:id/land` (thin, sem `landTenantId`) | qualquer usuário do lab | **papel exigido** (Regra 1) → senão `403 forbidden_role`. Resto igual: 201 / 409 `land_code_exists` / 409 `steps_incomplete` / 409 `journey_invalid_status`. |
| `POST` | `/api/journey/runs/:id/land` `{landTenantId}` | FK decide: UUID inexistente `400 invalid_reference`, existente `200` | papel exigido (Regra 1) → `journey_land_link()`; `false` → **`400 invalid_reference`** idêntico para inexistente / sem vínculo / ator não-admin no alvo (sem oráculo). `true` → `200` `mode=link`. `land_is_lab` 400 inalterado. |
| `POST` | `/api/journey/runs/:id/steps/:stepId/complete` | conviction exige os 3; ordem entre leverage/consensus/roles **não** travada | ordem **cravada** leverage → consensus → roles → conviction; step fora da sequência → **`409 steps_out_of_order`** `{ stepId, requires, missing }` (wire 0.3.9). Próximo só após complete do anterior. |
| `GET` | `/api/a4-readiness` | kind fora do vocabulário some em silêncio | `warnings[]` ganha `{ kind: "policy_kind_unknown", label, by, why }` (`by: string[]` = stable_ids das policies fora do vocabulário — mesmo shape dos outros warnings de readiness; count = `by.length`; `why` = "kind não está em tenant_settings.policy_kinds; não alimenta A4"). Estado `warn` se só isso; **nunca** `block`. |
| `POST` / `PATCH` | `/api/policies` | aceita kind desconhecido calado | mesmo status (201/200); body ganha `warnings: [{ code: "policy_kind_unknown", kind, why }]` quando o kind normalizado ∉ nenhum grupo efetivo. |
| `GET` | `/api/plans/approved/export` | — | **Fora Task 12** (W7/backlog). |

Nenhuma rota nova de journey; `scope` e `abandon` **sem mudança** (ver Fora).

## Regras
1. **Papel no land (ambos os modos):** `ctx.role ∈ {admin, domain_owner}` (**cravado PO**). Checado no app **antes** de qualquer leitura do alvo; `403 forbidden_role` com `{ required: [...] }`. Sem `x-user-id` → 401 como hoje.
2. **Link = referência válida, não "tenant existente".** Válido ⇔ o ator do lab (mesmo e-mail) é `admin` no tenant alvo (**cravado PO** — não restringe a tenant landado do lab). Qualquer falha → mesma resposta `400 invalid_reference {field: "landTenantId"}`, mesmo corpo, sem distinguir inexistente/sem vínculo. Remove o oráculo.
3. **Thin-create intocado:** `landTenantId` omitido → `journey_land_tenant()` 0016, pack default, 201/409/400 como W5. Regressão do curl W5 obrigatória.
4. **SECURITY DEFINER no padrão 0016:** `SET search_path`, `set_config('app.tenant_id', alvo, true)` só durante a leitura do alvo e **restaura o lab** antes de retornar; `REVOKE PUBLIC` + `GRANT EXECUTE` só `ibp_app`. App continua sem SELECT cross-tenant.
5. **RLS FORCE preservado; sem DELETE** em `journey_runs` (grants 0015 inalterados). Land link não copia nem lê dados do alvo além do teste de vínculo.
6. **Audit:** land ok grava `audit_log` como W5 + `actor_role`. Recusa (403/400) não grava linha (tx revertida) — log de app nível `warn` com `runId`, `actor`, motivo interno; **nunca** o motivo no corpo HTTP.
7. **Warn de kind não muda semântica:** kind desconhecido segue **fora** do `paramsFrom`/prontidão (F-1); W6 só torna visível. `{}` legado ≡ generic sem warn para kinds legados. Normalização = `normalizeKind`.
8. **Export:** fora do Task 12 (W7/backlog). Gate W6 **não** exige `src/http/plans*`.
9. **LLM zero / rede zero.** Gate W6 = W5 (sem rotas novas de plans neste Task).
10. **Ordem forçada dos steps (cravo PO + wire 0.3.9):** sequência fixa `leverage` → `consensus` → `roles` → `conviction`. Completar fora de ordem → `409 steps_out_of_order` com `{ stepId, requires, missing }` (shape do wire 0.3.9 / Didi). Conviction continua exigindo os 3 anteriores; land inalterado quanto a steps. Cabe no **Task 12** (thin, antes ou junto do harden land) — sem migration.

## DoD
- [ ] 0017 aplica/reaplica (idempotente); dump pré-0017; NOBYPASSRLS: função lê alvo e devolve `app.tenant_id` ao lab
- [ ] Steps: complete fora de ordem → `409 steps_out_of_order`; sequência leverage→consensus→roles→conviction ok (curl + unit)
- [ ] Land thin: 201 / 409 slug / 400 `land_is_lab` iguais ao W5 (curl W5 reexecutado)
- [ ] Land com papel fora da lista → 403 `forbidden_role` (thin e link)
- [ ] Link: UUID inexistente e tenant existente sem vínculo → **mesmo** 400 `invalid_reference` (corpo byte-igual); ator admin no alvo → 200 `mode=link`
- [ ] Kind desconhecido: readiness + POST/PATCH `/api/policies` com `warnings`/`policy_kind_unknown` + why; **sem** bump no summary A4; modelo F-1 intacto
- [ ] (não Task 12) export — W7/backlog
- [ ] typecheck · testes W0–W6 verdes · gate ok · curl evidence `/workspace/backups/w6-task12-curl-evidence.txt`
- [ ] Qualidade: matriz papel × modo (thin/link) × alvo (inexistente/sem vínculo/vinculado) + warn de kind no sample-demo

## Fora
- **Write-back ERP/TMS** (qualquer conector, push, sync) — fora do plano V0. Substituto V0 = export do plano aprovado (se entrar) + land thin, tudo **OS-only**.
- **Scope filter** da journey (`scope` segue registrado, `scopeFilter: "tenant_v0"`) — cravo PO: fica fora.
- **Endpoint `abandon`** (status `abandoned` segue reservado) — cravo PO: fica fora.
- Auth real (Clerk/Auth.js) — W6 usa o `Ctx` stub de headers; a regra de papel/vínculo sobrevive à troca.
- Convite/aceite cross-tenant (vínculo sem e-mail igual); RBAC fino por tela; `warnings` no `a4-run-summary.schema.json` (schema `additionalProperties:false` — só se PO pedir); métrica/dashboard de kinds desconhecidos.
- Export plano aprovado JSON/CSV (W7/backlog); Export PDF/XLSX; export de `latest_run`.

## Cravos PO — **cravados 2026-10-30**
1. **Papéis land:** `admin` + `domain_owner` — thin e link iguais.
2. **Vínculo link:** mesmo e-mail **admin** no alvo (sem oráculo). Não restringe a “só landado do lab”.
3. **Export:** **Fora** do Task 12 → W7/backlog. Task 12 = harden + warn only (+ ordem steps).
4. **Warn kind:** só **readiness + `/api/policies`**. Sem bump no summary A4.
5. **Ordem steps:** `409 steps_out_of_order` `{ stepId, requires, missing }` — API ≡ wire 0.3.9; bite curto no Task 12 após harden (ou residual W5 no mesmo PR).
