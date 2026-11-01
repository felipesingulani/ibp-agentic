#!/usr/bin/env python3
"""W1c — solver A4 piloto: CBC (open-source, via ortools.linear_solver) em processo filho.
Entrada (stdin JSON): {"vars":[{"name","lb","ub"|null,"obj"}], "cons":[{"name","lb"|null,"ub"|null,"coefs":{var:coef}}],
                       "timeLimitMs": int}
Saída (stdout JSON): {"status": "optimal|feasible|infeasible|unbounded|abnormal|not_solved",
                      "objective": float|null, "values": {var: float}, "wallMs": int}
Sem LLM, sem rede, sem acesso a banco: só resolve o modelo que o TS montou (src/a4/model.ts).
T-A4-SOLVER-WORKER: núcleo extraído em solve_model(m) (reusado por solver/worker.py); stdin/stdout inalterados.
"""
import json
import sys
import time

from ortools.linear_solver import pywraplp

STATUS = {
    pywraplp.Solver.OPTIMAL: "optimal",
    pywraplp.Solver.FEASIBLE: "feasible",
    pywraplp.Solver.INFEASIBLE: "infeasible",
    pywraplp.Solver.UNBOUNDED: "unbounded",
    pywraplp.Solver.ABNORMAL: "abnormal",
    pywraplp.Solver.NOT_SOLVED: "not_solved",
}


def solve_model(m: dict) -> dict:
    t0 = time.time()
    s = pywraplp.Solver.CreateSolver("CBC")
    if s is None:
        return {"status": "abnormal", "error": "CBC indisponível"}
    inf = s.infinity()
    s.SetTimeLimit(int(m.get("timeLimitMs", 5000)))
    v = {}
    for d in m["vars"]:
        ub = d.get("ub")
        v[d["name"]] = s.NumVar(float(d.get("lb", 0)), inf if ub is None else float(ub), d["name"])
    for c in m["cons"]:
        lb, ub = c.get("lb"), c.get("ub")
        ct = s.Constraint(-inf if lb is None else float(lb), inf if ub is None else float(ub), c["name"])
        for name, coef in c["coefs"].items():
            ct.SetCoefficient(v[name], float(coef))
    obj = s.Objective()
    for d in m["vars"]:
        if d.get("obj"):
            obj.SetCoefficient(v[d["name"]], float(d["obj"]))
    obj.SetMinimization()
    st = STATUS.get(s.Solve(), "abnormal")
    ok = st in ("optimal", "feasible")
    return {
        "status": st,
        "objective": obj.Value() if ok else None,
        "values": {k: x.solution_value() for k, x in v.items()} if ok else {},
        "wallMs": int((time.time() - t0) * 1000),
    }


def main() -> None:
    print(json.dumps(solve_model(json.load(sys.stdin))))


if __name__ == "__main__":
    main()
