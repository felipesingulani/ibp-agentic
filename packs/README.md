# packs/ — seeds de pack de indústria (Task 9 / W3b)

Lidos **só na escrita** (`POST /api/cadastro/pack`, `PUT /api/cadastro/alcada` → switch p/ `generic`) e no `GET /api/cadastro/packs`.
Em runtime o código lê **só `tenant_settings`** (nunca o pack). Espelham o `PACKS` do wire shell v0.3.5 + bloco `alcada`
(contrato `docs/architecture/W3B-CADASTRO-WRITE-API-CONTRACT.md`). "Pack inclui alçada" ≡ `policy_kinds.alcada` presente.
Pack novo = pasta nova `packs/<id>/profile.json` (validado por zod em `src/cadastro/packs.ts`; sem migration).
