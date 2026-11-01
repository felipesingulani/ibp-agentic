Harness W0: escopo, PR checklist, guardrails. A lei do agent está na raiz: `/AGENTS.md` + `/INDEX.md`.

Harness **V0** (L0–L3, L4 fora): contrato em [`docs/architecture/HARNESS.md`](../architecture/HARNESS.md). L0 = `npm run harness:l0` (typecheck, gate, INDEX, pins md5, `npm test`) e o workflow `.github/workflows/ci.yml`. L1 = `harness/pins.json`. L2 = smoke GET S1–S8 (`npm run harness:smoke`). L3 = relatório QA-ACCEPTANCE + SHA + md5 (`npm run harness:report`). Fora do V0: Playwright, Pact, branch Neon por PR, LLM judge.
