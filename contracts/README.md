# Contratos V0 — IBP Agentic

Versionados em 2026-10-30 (rev. wire Didi v0.2). Stack: OR-Tools + state machine + Postgres + LLM só intent→cartões. Custo piloto baixo, LLM sob demanda.

| Schema | Uso |
|--------|-----|
| `premise-card.schema.json` | Cartões tipados A1–A3; **Gap exige `links.nodeId`** |
| `a4-reason.schema.json` | Razão individual do otimizador (`info\|warn\|block`) |
| `a4-run-summary.schema.json` | Always-on: até 3 razões + `countsByKind` + **`scenarioVersion`** |
| `decision-event.schema.json` | Aprovar/escalar + **porquê** obrigatório (audit trail) |
| `plan-export.schema.json` | **W7** — envelope do export do plano aprovado (`GET /api/plans/approved/export?format=json`; ajv em runtime; ver `docs/architecture/W7-PLAN-EXPORT-CONTRACT.md`) |
| `alcada-queue-item.schema.json` | **Rascunho W3** — item da fila de alçada Finance (projeção; ver `docs/architecture/W3-PULSE-VISOES-API-CONTRACT.md`) |
| `scenario-finance.schema.json` | **T-BIZ-WC-V0 + MARGIN** — `ScenarioFinance` `sf.v0` (WC dias de ciclo + MC/payback stub); ajv em `GET /api/scenarios/:id/finance` |

Wire: `../2026-10-30-ibp-agentic-ux-wire-happy-path-v0.2.html`

| `v0-postgres-cadastro.sql` | Master data §5 + scenarios/premises/A4/decisions + RLS tenant |
