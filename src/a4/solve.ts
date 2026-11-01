/**
 * W1c — executa o modelo no CBC (open-source). Dois caminhos (T-A4-SOLVER-WORKER · A4-SOLVER-WORKER-CONTRACT.md §4):
 *  - A4_SOLVER_URL set → HTTP `POST ${URL}/v1/solve` no worker (solver/worker.py), header x-a4-solver-secret = A4_SOLVER_SECRET,
 *    timeout = timeLimitMs + grace (cap 25s). Rede/timeout/5xx/401/JSON inválido → SolverError("solver_unavailable").
 *  - senão → processo filho Python (solver/cbc_solve.py), como sempre: timeout duro SIGKILL após timeLimitMs + grace;
 *    sem rede/banco no filho; stdin JSON → stdout JSON. Python configurável por env A4_PYTHON (default: solver/.venv/bin/python).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { LpModel } from "./model.js";

export type SolverStatus = "optimal" | "feasible" | "infeasible" | "unbounded" | "abnormal" | "not_solved";
export interface SolveResult { status: SolverStatus; objective: number | null; values: Record<string, number>; wallMs: number }

export class SolverError extends Error {}

export const SOLVER_UNAVAILABLE = "solver_unavailable";
export const REMOTE_TIMEOUT_CAP_MS = 25_000;
export const HEALTH_TIMEOUT_MS = 2_000;
const STATUSES: readonly string[] = ["optimal", "feasible", "infeasible", "unbounded", "abnormal", "not_solved"];

export function solverPython(): string {
  const p = process.env.A4_PYTHON ?? "solver/.venv/bin/python";
  return existsSync(p) || !p.includes("/") ? p : "python3";
}

/** URL base do worker (sem barra final) ou null → spawn local. */
export function remoteSolverUrl(): string | null {
  const u = process.env.A4_SOLVER_URL?.trim();
  return u ? u.replace(/\/+$/, "") : null;
}

export function solve(model: LpModel, opts: { graceMs?: number } = {}): Promise<SolveResult> {
  const url = remoteSolverUrl();
  return url ? solveRemote(url, model, opts) : solveLocal(model, opts);
}

function isSolveResult(x: unknown): x is SolveResult {
  const r = x as SolveResult;
  return !!r && typeof r === "object" && STATUSES.includes(r.status) && (r.objective === null || typeof r.objective === "number")
    && !!r.values && typeof r.values === "object" && typeof r.wallMs === "number";
}

async function solveRemote(url: string, model: LpModel, opts: { graceMs?: number }): Promise<SolveResult> {
  const ms = Math.min(model.timeLimitMs + (opts.graceMs ?? 3000), REMOTE_TIMEOUT_CAP_MS);
  try {
    const res = await fetch(`${url}/v1/solve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-a4-solver-secret": process.env.A4_SOLVER_SECRET ?? "" },
      body: JSON.stringify(model),
      signal: AbortSignal.timeout(ms), // cobre conexão + corpo
    });
    if (res.status !== 200) throw new Error("status");
    const out: unknown = await res.json();
    if (!isSolveResult(out)) throw new Error("shape");
    return out;
  } catch {
    // mensagem estável: sem URL/stack/status no a4_runs.error
    throw new SolverError(SOLVER_UNAVAILABLE);
  }
}

/** Preflight do POST /api/a4-runs: GET ${URL}/health (2s) → true só com 200 {ok:true}. */
export async function remoteSolverHealthy(url: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return false;
    return ((await res.json()) as { ok?: unknown })?.ok === true;
  } catch {
    return false;
  }
}

function solveLocal(model: LpModel, opts: { graceMs?: number }): Promise<SolveResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(solverPython(), ["solver/cbc_solve.py"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    let out = "", err = "", done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true; child.kill("SIGKILL"); reject(new SolverError("timeout"));
    }, model.timeLimitMs + (opts.graceMs ?? 3000));
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); reject(new SolverError(`spawn: ${e.message}`)); } });
    child.on("close", (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (code !== 0) return reject(new SolverError(`solver exit ${code}: ${err.trim().split("\n").pop() ?? ""}`.slice(0, 300)));
      try { resolve(JSON.parse(out) as SolveResult); } catch { reject(new SolverError("solver output inválido")); }
    });
    child.stdin.end(JSON.stringify(model));
  });
}
