#!/usr/bin/env bash
# Fail if W0-forbidden patterns appear in app source (exclude docs/wires).
set -euo pipefail
ROOT="${1:-.}"
PATTERN='openai|anthropic|ChatCompletion|langgraph|ortools|OR-Tools|gurobi|/scenarios|/ditado|/optimize'
if grep -RInE "$PATTERN" "$ROOT" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs \
  --exclude='*.md' --exclude='*.html' 2>/dev/null; then
  echo "W0 grep gate FAILED — padrões de cenário/LLM/solver encontrados."
  exit 1
fi
echo "W0 grep gate OK"
