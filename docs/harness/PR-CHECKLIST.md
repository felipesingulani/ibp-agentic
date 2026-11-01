# PR checklist — W0

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
