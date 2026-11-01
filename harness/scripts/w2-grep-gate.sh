#!/usr/bin/env bash
# W2 gate (Task 6 · W2-WIZARD-API-CONTRACT.md): abre SÓ os caminhos do wizard; resto continua negado.
#  1) DENY em tudo: SDK/vendor LLM, orquestradores, solver pago, rota optimize.
#  2) Rotas '/api/scenarios', "/scenarios", '/:id/ditado' só nos arquivos do wizard (ALLOW). Import de módulo (./scenarios.js) não conta.
#  3) Marcadores de chamada LLM (env do provedor, payload de chat) só em src/wizard/ (+ testes do wizard).
#  4) fetch( em src/ só em src/wizard/ (backend não chama rede fora do ditado; A7 prose LLM continua negado).
#  5) A7 (Task 7, src/a7/ + src/http/decision-events.ts) é determinístico: sem import do wizard/ditado, sem fetch(,
#     sem marcador de LLM/prompt/narrativa — A7 prose por LLM continua NEGADO até wave própria.
#  6) W3 (Task 8, src/w3/ + src/http/pulse*|visoes*|alcada*) é GET puro e determinístico: mesmos marcadores da regra 5
#     + sem escrita SQL (INSERT/UPDATE/DELETE) + sem rota de escrita (.post/.put/.patch/.delete). Aprovar/escalar = POST A7.
#  7) W3b (Task 9, src/cadastro/ + src/http/cadastro.ts + packs/) é determinístico: mesmos marcadores da regra 5
#     (sem LLM/prompt/fetch(/ditado). Escrita SQL é permitida aqui (é a API de cadastro); regra 6 segue intacta p/ src/w3/.
#  8) W4 (Task 10, src/execution/ + src/http/execution*) é determinístico: mesmos marcadores da regra 5 (sem LLM/prompt/
#     fetch(/ditado/narrativa). Escrita SQL permitida (INSERT + UPDATE status→void; sem DELETE na API); Pulse lê via src/w3 (regra 6).
#  9) W5 (Task 11, src/journey/ + src/http/journey*) é determinístico: mesmos marcadores da regra 5 (sem LLM/prompt/
#     fetch(/ditado/narrativa) + sem cliente de rede (node:http(s), axios, undici) + sem DELETE (abandon = status).
#     Conviction pack = templates pt-BR + números do snapshot.
# 10) W7 (Task 13, src/plans/ + src/http/plans*) é read-only e determinístico: mesmos marcadores da regra 9 (sem LLM/prompt/
#     fetch(/ditado/narrativa, sem cliente de rede node:http(s)/axios/undici) + sem SQL INSERT/UPDATE/DELETE direto
#     (única escrita = audit() de http/common.ts) + sem rota de escrita (.post/.put/.patch/.delete). Export = GET + attachment.
# 11) A1 (T-A1-ENG · A1-CURVA-DEMANDA-CONTRACT.md §9): src/wizard/ só LÊ sales_history (hist → curva) — nenhum
#     INSERT/UPDATE/DELETE em sales_history no wizard. Teste A1 (test/integration/a1-curva.test.ts) entra no ALLOW das rotas.
# 12) A7 leve (T-A7-LEVE · A7-ORCHESTRATOR-LEVE-CONTRACT.md §8): regra 5 cobre também src/http/a7*.ts; e no path A7
#     (src/a7/ + src/http/a7*) nada de disparar/escrever A4 (rota a4-runs, INSERT em a4_runs, import do solver/executeRun),
#     solver pago/otimização (Gurobi/cplex/optimize) nem cliente de rede/ERP (node:http(s), axios, undici). A7 só LÊ a4_runs.
# 13) A4 worker (T-A4-SOLVER-WORKER · A4-SOLVER-WORKER-CONTRACT.md §4): fetch( liberado SÓ em src/a4/solve.ts
#     (POST ${A4_SOLVER_URL}/v1/solve + preflight /health). Resto do backend segue sem fetch( (regra 4).
# 14) T-BIZ-CAD-GATES: GET /api/scenarios/:id/gates mora no router do wizard; o teste de paridade entra no ALLOW das rotas.
# Histórico: w0-grep-gate.sh (W0), w1-grep-gate.sh (W1c).
set -euo pipefail
ROOT="${1:-.}"
ALLOW='^(\./)?(src/http/scenarios\.ts|src/wizard/|test/integration/wizard-api\.test\.ts|test/integration/a1-curva\.test\.ts|test/integration/cadastro-gates\.test\.ts|test/unit/ditado\.test\.ts)'
fail=0
scan() { # $1=pattern → linhas "arquivo:linha:texto" (caminho relativo ao repo)
  grep -RInE "$1" "$ROOT" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs --exclude-dir=.venv \
    --exclude='*.md' --exclude='*.html' 2>/dev/null || true
}
report() { if [ -n "$2" ]; then echo "$2"; echo "W2 gate: $1"; fail=1; fi; }

report "LLM vendor/orquestrador/solver pago/optimize proibido" \
  "$(scan 'openai|anthropic|ChatCompletion|langgraph|langchain|gurobi|cplex|/optimize')"
report "rota de wizard fora dos arquivos permitidos" \
  "$(scan "/api/(scenarios|ditado)|[\"'\`]/(scenarios|ditado)|/:[A-Za-z_]+/ditado" | grep -Ev "$ALLOW" || true)"
report "chamada LLM fora de src/wizard/" \
  "$(scan 'DITADO_LLM_|response_format|max_tokens|role: ?"system"' | grep -Ev "$ALLOW" || true)"
report "fetch( no backend fora de src/wizard/" \
  "$(scan 'fetch\(' | grep -E '^(\./)?src/' | grep -Ev '^(\./)?src/(wizard/|a4/solve\.ts:)' || true)"

report "A7 com LLM/prosa/rede (A7 stub é determinístico)" \
  "$(scan '(^|[^A-Za-z])[Dd]itado|wizard/|fetch\(|[Ll][Ll][Mm]|[Pp]rompt|[Nn]arrativ|[Cc]ompletion|[Gg]enerateText' | grep -E '^(\./)?src/(a7/|http/(decision-events|a7)[^/]*\.ts)' || true)"

A7P='^(\./)?src/(a7/|http/a7)'
report "A7 leve disparando/escrevendo A4, solver/otimização ou rede/ERP (A7 só lê a4_runs; zero write-back)" \
  "$(scan 'a4-runs|INSERT[[:space:]]+INTO[[:space:]]+a4_runs|insert into a4_runs|UPDATE[[:space:]]+a4_runs|[Gg]urobi|GUROBI|[Oo]ptimi[sz]e|a4/(solve|run|model)(\.js)?["'"'"']|executeRun|cplex|node:https?["/]|from "https?"|axios|undici|XMLHttpRequest' | grep -E "$A7P" || true)"

W3='^(\./)?src/(w3/|http/(pulse|visoes|alcada))'
report "W3 com LLM/prosa/rede (Pulse/Visões/alçada são derivados, sem agente)" \
  "$(scan '(^|[^A-Za-z])[Dd]itado|wizard/|fetch\(|[Ll][Ll][Mm]|[Pp]rompt|[Nn]arrativ|[Cc]ompletion|[Gg]enerateText' | grep -E "$W3" || true)"
report "W3 com escrita (endpoints W3 são GET puros; só SELECT)" \
  "$(scan '(^|[^A-Za-z_])(INSERT|UPDATE|DELETE|insert into|update [a-z_]+ set|delete from)([^A-Za-z_]|$)|\.(post|put|patch|delete)\(' | grep -E "$W3" || true)"

CAD='^(\./)?(src/(cadastro/|http/cadastro)|packs/)'
report "Cadastro (W3b) com LLM/prosa/rede (packs + alçada são config determinística)" \
  "$(scan '(^|[^A-Za-z])[Dd]itado|wizard/|fetch\(|[Ll][Ll][Mm]|[Pp]rompt|[Nn]arrativ|[Cc]ompletion|[Gg]enerateText' | grep -E "$CAD" || true)"

EXE='^(\./)?src/(execution/|http/execution)'
report "Execução (W4) com LLM/prosa/rede (movimentos + exceções são determinísticos, limiar fixo)" \
  "$(scan '(^|[^A-Za-z])[Dd]itado|wizard/|fetch\(|[Ll][Ll][Mm]|[Pp]rompt|[Nn]arrativ|[Cc]ompletion|[Gg]enerateText' | grep -E "$EXE" || true)"
report "Execução (W4) com DELETE (append-only: correção = void com why)" \
  "$(scan '(^|[^A-Za-z_])(DELETE|delete from)([^A-Za-z_]|$)|\.delete\(' | grep -E "$EXE" || true)"

JRN='^(\./)?src/(journey/|http/journey)'
report "Journey (W5) com LLM/prosa/rede (conviction pack = template pt-BR + números do snapshot)" \
  "$(scan '(^|[^A-Za-z])[Dd]itado|wizard/|fetch\(|[Ll][Ll][Mm]|[Pp]rompt|[Nn]arrativ|[Cc]ompletion|[Gg]enerateText|node:https?["/]|from "https?"|axios|undici|XMLHttpRequest' | grep -E "$JRN" || true)"
report "Journey (W5) com DELETE (journey_runs sem DELETE; abandon = status)" \
  "$(scan '(^|[^A-Za-z_])(DELETE|delete from)([^A-Za-z_]|$)|\.delete\(' | grep -E "$JRN" || true)"

PLN='^(\./)?src/(plans/|http/plans)'
report "Export plano (W7) com LLM/prosa/rede (export = a4_runs.plan cru, sem ERP/rede)" \
  "$(scan '(^|[^A-Za-z])[Dd]itado|wizard/|fetch\(|[Ll][Ll][Mm]|[Pp]rompt|[Nn]arrativ|[Cc]ompletion|[Gg]enerateText|node:https?["/]|from "https?"|axios|undici|XMLHttpRequest' | grep -E "$PLN" || true)"
report "Export plano (W7) com escrita (só GET; única escrita = audit() de http/common.ts)" \
  "$(scan '(^|[^A-Za-z_])(INSERT|UPDATE|DELETE|insert into|update [a-z_]+ set|delete from)([^A-Za-z_]|$)|\.(post|put|patch|delete)\(' | grep -E "$PLN" || true)"

report "A1 (wizard) com escrita em sales_history (hist é read-only; curva só em premise_cards)" \
  "$(scan '(INSERT[[:space:]]+INTO|UPDATE|DELETE[[:space:]]+FROM|insert into|update|delete from|TRUNCATE|truncate)[^;]*sales_history|sales_history[^;]*[[:space:]](SET|set)[[:space:]]' | grep -E '^(\./)?src/wizard/' || true)"

[ "$fail" = 0 ] || { echo "W2 grep gate FAILED ($ROOT)"; exit 1; }
echo "W2 grep gate OK ($ROOT)"
