/**
 * L2 — smoke GET-only S1–S8. Nenhum POST/PUT/PATCH/DELETE.
 *
 *   S1  GET /health                         → 200 { ok: true }
 *   S2  GET /api/me                         → 401 (sem x-tenant-id)
 *   S3  GET /api/pulse/summary              → 401
 *   S4  GET /api/a4-readiness               → 401
 *   S5  GET /api/me                         → 200 tenant seed
 *   S6  GET /api/pulse/summary              → 200 tenant seed
 *   S7  GET /api/a4-readiness               → 200 tenant seed (data.state)
 *   S8  GET /  md5 = pin public/index.html
 *       GET ${A4_SOLVER_URL}/health         → 200 { ok: true }
 *
 * Env:
 *   HARNESS_BASE_URL     default http://127.0.0.1:$PORT (PORT default 3000)
 *   HARNESS_TENANT_ID    uuid do tenant seed (`npm run seed` imprime TENANT_ID)
 *   A4_SOLVER_URL        worker; vazio falha S8 salvo HARNESS_SKIP_WORKER=1
 *   HARNESS_SKIP_WORKER  =1 marca o worker como skip (UI ainda obrigatória)
 *
 * Stdout termina com `SMOKE_MD5 <32 hex>` do JSON canônico dos 8 checks.
 */
import { md5Bytes, pinByPath } from "./lib.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Check = { id: string; ok: boolean; status: number | null; detail: string };

const base = (process.env.HARNESS_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`).replace(/\/+$/, "");
const tenant = (process.env.HARNESS_TENANT_ID ?? "").trim();
const solver = (process.env.A4_SOLVER_URL ?? "").trim().replace(/\/+$/, "");
const skipWorker = process.env.HARNESS_SKIP_WORKER === "1";

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function get(url: string, headers?: Record<string, string>): Promise<{ status: number; bytes: Buffer; json: unknown }> {
  const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(10_000) });
  const bytes = Buffer.from(await res.arrayBuffer());
  let json: unknown = null;
  if ((res.headers.get("content-type") ?? "").includes("json")) {
    try { json = JSON.parse(bytes.toString("utf8")) as unknown; } catch { json = null; }
  }
  return { status: res.status, bytes, json };
}

async function probe(url: string, headers?: Record<string, string>): Promise<{ status: number | null; bytes: Buffer | null; json: unknown; error?: string }> {
  try {
    const r = await get(url, headers);
    return r;
  } catch (e) {
    return { status: null, bytes: null, json: null, error: e instanceof Error ? e.message : String(e) };
  }
}

const checks: Check[] = [];

function push(id: string, ok: boolean, status: number | null, detail: string) {
  checks.push({ id, ok, status, detail });
  console.log(`${ok ? "OK  " : "FAIL"} ${id}  ${detail}`);
}

const health = await probe(`${base}/health`);
push("S1", health.status === 200 && isRecord(health.json) && health.json.ok === true,
  health.status, health.error ?? `GET /health ${health.status}`);

for (const [id, path] of [["S2", "/api/me"], ["S3", "/api/pulse/summary"], ["S4", "/api/a4-readiness"]] as const) {
  const r = await probe(`${base}${path}`);
  push(id, r.status === 401, r.status, r.error ?? `GET ${path} ${r.status}`);
}

const seedHeaders = UUID_RE.test(tenant) ? { "x-tenant-id": tenant } : undefined;

const me = seedHeaders ? await probe(`${base}/api/me`, seedHeaders) : { status: null, bytes: null, json: null, error: "HARNESS_TENANT_ID ausente ou inválido" };
const meId = isRecord(me.json) && isRecord(me.json.data) ? me.json.data.tenantId : undefined;
push("S5", me.status === 200 && meId === tenant, me.status, me.error ?? `GET /api/me ${me.status} tenant=${String(meId ?? "")}`);

const pulse = seedHeaders ? await probe(`${base}/api/pulse/summary`, seedHeaders) : { status: null, json: null, error: "HARNESS_TENANT_ID ausente ou inválido" };
push("S6", pulse.status === 200 && isRecord(pulse.json) && isRecord(pulse.json.data),
  pulse.status, pulse.error ?? `GET /api/pulse/summary ${pulse.status}`);

const ready = seedHeaders ? await probe(`${base}/api/a4-readiness`, seedHeaders) : { status: null, json: null, error: "HARNESS_TENANT_ID ausente ou inválido" };
const state = isRecord(ready.json) && isRecord(ready.json.data) ? ready.json.data.state : undefined;
push("S7", ready.status === 200 && typeof state === "string",
  ready.status, ready.error ?? `GET /api/a4-readiness ${ready.status} state=${String(state ?? "")}`);

const uiPin = pinByPath("public/index.html");
const ui = await probe(`${base}/`);
const uiMd5 = ui.bytes ? md5Bytes(ui.bytes) : "";
const uiOk = !!uiPin && ui.status === 200 && uiMd5 === uiPin.md5;

let workerDetail: string;
let workerOk: boolean;
if (skipWorker) {
  workerOk = true;
  workerDetail = "worker=skip";
} else if (!solver) {
  workerOk = false;
  workerDetail = "worker=A4_SOLVER_URL ausente";
} else {
  const w = await probe(`${solver}/health`);
  workerOk = w.status === 200 && isRecord(w.json) && w.json.ok === true;
  workerDetail = w.error ? `worker=${w.error}` : `worker=GET /health ${w.status}`;
}

push("S8", uiOk && workerOk, ui.status,
  `ui=${uiMd5 || (ui.error ?? "sem corpo")}${uiPin ? "" : " (pin public/index.html ausente)"} ${workerDetail}`);

const canonical = JSON.stringify(checks.map((c) => ({ id: c.id, ok: c.ok, status: c.status, detail: c.detail })));
const smokeMd5 = md5Bytes(Buffer.from(canonical));
const failed = checks.filter((c) => !c.ok).length;
console.log(`SMOKE_MD5 ${smokeMd5}`);
console.log(`smoke: ${checks.length - failed}/${checks.length}`);
if (failed) process.exit(1);
