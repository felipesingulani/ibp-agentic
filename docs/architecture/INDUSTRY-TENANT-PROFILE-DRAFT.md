# Draft — Industry / Tenant Profile

Status: **rascunho Deivid** · base pro discovery PO (cadastros + agentes agnósticos vs setup por indústria)

## Problema
Hoje o “vocabulário” de domínio está espalhado: `POLICY_KINDS` no código, `kpi_labels`/`node_types` em `tenant_settings`, wires com labels genéricos. Precisamos de um **perfil de tenant** (e opcionalmente um **pack de indústria**) que configure o roster A1–A7 sem hardcode vertical.

## Proposta (V0.x)
```json
{
  "profile_id": "generic|oilgas|cpg|retail|…",
  "labels": {
    "node": "Nó",
    "capacity": "Capacidade",
    "route": "Rota",
    "sku": "SKU",
    "contract": "Contrato"
  },
  "policy_kinds": {
    "working_capital": ["working_capital", "capital_de_giro", "wc"],
    "inventory": ["inventory", "estoque", "stock"],
    "service": ["service", "servico", "service_level"]
  },
  "kpi_aliases": { "wc": "…", "service": "…", "cost": "…" },
  "agents": {
    "A1": { "enabled": true, "card_types": ["NovaFilial", "CurvaDemanda"] },
    "A2": { "enabled": true, "card_types": ["Investimento"] },
    "A3": { "enabled": true, "card_types": ["Gap"] },
    "A4": { "enabled": true, "solver": "cbc", "reason_kinds": ["janela","capacidade","contrato","custo","outro"] },
    "A5": { "enabled": false },
    "A6": { "enabled": false },
    "A7": { "enabled": false, "mode": "state_machine_only" }
  },
  "readiness": {
    "require_supplier_contract_when": "supply_external_in_scope"
  },
  "currency_default": null,
  "uom_default": null
}
```

## Onde vive
1. **Pack de indústria** (repo): `packs/<id>/profile.json` — seed/template.
2. **Tenant** (runtime): merge em `tenant_settings` (`policy_kinds jsonb`, `entity_labels jsonb`, `agent_roster jsonb`) — override do pack.
3. Código lê **só** do tenant (nunca do pack em runtime).

## Regras
- Enums de **contrato** (`PremiseCard.type`, `A4Reason.kind`) **não** mudam por indústria — só labels e quais tipos o roster liga.
- `POLICY_KINDS` sai do código quando `tenant_settings.policy_kinds` existir (migration thin).
- Discovery PO decide: (a) só perfil genérico + knobs, ou (b) packs por indústria no onboarding.

## Fora deste draft
Implementação, UI de setup, LLM prompts por indústria.
