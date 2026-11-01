#!/usr/bin/env bash
# W1 gate (A4 solver aprovado — W1C-OR-TOOLS-DESIGN.md, Deivid): CBC open-source passa a ser permitido.
# Continua proibido: LLM/tokens (W2), solver pago (Gurobi/CPLEX), rota de ditado, scenarios via HTTP.
# W0 original preservado em w0-grep-gate.sh (histórico).
set -euo pipefail
ROOT="${1:-.}"
PATTERN='openai|anthropic|ChatCompletion|langgraph|langchain|gurobi|cplex|/scenarios|/ditado|/optimize'
if grep -RInE "$PATTERN" "$ROOT" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs --exclude-dir=.venv \
  --exclude='*.md' --exclude='*.html' 2>/dev/null; then
  echo "W1 grep gate FAILED — padrões de LLM/solver pago/ditado encontrados."
  exit 1
fi
echo "W1 grep gate OK ($ROOT)"
