#!/usr/bin/env python3
"""T-A4-SOLVER-WORKER (A4-SOLVER-WORKER-CONTRACT.md §3) — worker HTTP thin do solver A4 (stdlib, sem framework).
  GET  /health    → 200 {"ok": true}                (sem auth)
  POST /v1/solve  → 200 = stdout de cbc_solve.py     (header x-a4-solver-secret = $A4_SOLVER_SECRET)
                    401 secret ausente/errado · 400 JSON inválido/campos faltando · 500 {"error": "..."} curto
Sem LLM, sem DB, sem tenant: só resolve o LP que o Node montou. Porta = $PORT (default 8080).
Fail-closed: sem A4_SOLVER_SECRET no ambiente o worker não sobe.
"""
import hmac
import json
import math
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cbc_solve import solve_model

MAX_BODY = 8 * 1024 * 1024  # LP piloto é pequeno (≤50 nós); trava abuso


def _num_or_none(x) -> bool:
    return x is None or (isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x))


def validate(m) -> str | None:
    """Campos exigidos pelo cbc_solve.py; devolve motivo curto ou None."""
    if not isinstance(m, dict):
        return "body must be an object"
    vs, cs = m.get("vars"), m.get("cons")
    if not isinstance(vs, list) or not isinstance(cs, list):
        return "vars/cons must be arrays"
    names = set()
    for d in vs:
        if not isinstance(d, dict) or not isinstance(d.get("name"), str):
            return "var.name required"
        if not all(_num_or_none(d.get(k)) for k in ("lb", "ub", "obj")):
            return "var lb/ub/obj must be numbers or null"
        names.add(d["name"])
    for c in cs:
        if not isinstance(c, dict) or not isinstance(c.get("name"), str) or not isinstance(c.get("coefs"), dict):
            return "con.name/coefs required"
        if not _num_or_none(c.get("lb")) or not _num_or_none(c.get("ub")):
            return "con lb/ub must be numbers or null"
        for k, coef in c["coefs"].items():
            if k not in names or not _num_or_none(coef) or coef is None:
                return "con.coefs must reference vars with numeric coef"
    t = m.get("timeLimitMs", 5000)
    if not isinstance(t, int) or isinstance(t, bool) or t < 1 or t > 60000:
        return "timeLimitMs must be int 1..60000"
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "a4-solver/1"
    sys_version = ""

    def _json(self, code: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            return self._json(200, {"ok": True})
        self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/solve":
            return self._json(404, {"error": "not_found"})
        got = self.headers.get("x-a4-solver-secret") or ""
        if not hmac.compare_digest(got.encode(), self.server.secret.encode()):  # type: ignore[attr-defined]
            return self._json(401, {"error": "unauthorized"})
        try:
            n = int(self.headers.get("content-length") or 0)
        except ValueError:
            n = -1
        if n <= 0 or n > MAX_BODY:
            return self._json(400, {"error": "invalid_body"})
        try:
            m = json.loads(self.rfile.read(n))
        except (ValueError, UnicodeDecodeError):
            return self._json(400, {"error": "invalid_json"})
        why = validate(m)
        if why:
            return self._json(400, {"error": "invalid_model", "detail": why})
        try:
            out = solve_model(m)
        except Exception:  # CBC/ortools crash → 500 curto (sem stack)
            return self._json(500, {"error": "solver_failed"})
        if "error" in out:
            return self._json(500, {"error": "solver_failed"})
        self._json(200, out)

    def log_message(self, fmt: str, *args) -> None:  # 1 linha por request, sem body/headers (secret nunca vai pro log)
        sys.stderr.write("a4-solver %s %s\n" % (self.command, fmt % args if args else fmt))


def main() -> None:
    secret = os.environ.get("A4_SOLVER_SECRET", "")
    if not secret:
        sys.stderr.write("a4-solver: A4_SOLVER_SECRET ausente — recusando subir (fail-closed)\n")
        sys.exit(2)
    port = int(os.environ.get("PORT", "8080"))
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    srv.secret = secret  # type: ignore[attr-defined]
    sys.stderr.write(f"a4-solver listening on :{port}\n")
    srv.serve_forever()


if __name__ == "__main__":
    main()
