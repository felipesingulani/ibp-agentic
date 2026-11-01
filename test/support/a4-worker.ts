// T-A4-SOLVER-WORKER: sobe solver/worker.py (Python real do venv) numa porta livre p/ testes; devolve url + log + stop.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { solverPython } from "../../src/a4/solve.js";

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    }).on("error", rej);
  });
}

export async function startWorker(secret: string) {
  const port = await freePort();
  const child = spawn(solverPython(), ["solver/worker.py"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH ?? "", PORT: String(port), A4_SOLVER_SECRET: secret },
  });
  let log = "";
  child.stderr.on("data", (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* subindo */ }
    if (child.exitCode !== null) throw new Error(`worker saiu: ${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url, port,
    log: () => log,
    stop: () => new Promise<void>((r) => { if (child.exitCode !== null) return r(); child.once("exit", () => r()); child.kill("SIGTERM"); }),
  };
}
