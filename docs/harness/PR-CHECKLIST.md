# PR checklist

## Harness V0

Contrato: `docs/architecture/HARNESS.md`.

- [ ] `npm run harness:l0` green (typecheck, gate, INDEX, pins, `npm test`) — ou os cinco passos iguais no CI
- [ ] Se um arquivo de `harness/pins.json` mudou: md5 atualizado no mesmo PR; schema, SQL ou contrato A4 com review do Arquiteto
- [ ] UI `public/index.html` continua no pin `41d290c9…` (W6 live), salvo task que o PO tenha autorizado a mexer na UI
- [ ] Sem Playwright, Pact, branch Neon por PR ou LLM judge (L4 — fora do V0)
- [ ] Sem secrets commitados

## W0 (histórico — foundation)

- [ ] Escopo só W0 (nada de cenário/LLM/A4)
- [ ] Migrations idempotentes / aplicadas no compose
- [ ] Todo SELECT/INSERT com tenant (ou coberto por RLS testado)
- [ ] Sem secrets commitados
- [ ] Sem hardcode de indústria/demo como se fosse domínio
- [ ] Schemas em `contracts/` não alterados **ou** mudança aprovada pelo Arquiteto
- [ ] Testes novos/atualizados + comando e output colados
- [ ] README do app atualizado (como subir local)
- [ ] Nenhuma dependência nova sem justificativa de 1 linha no PR

Revisor sugerido: **Deivid** (arquitetura) + **PO** se tocar UX/copy.
