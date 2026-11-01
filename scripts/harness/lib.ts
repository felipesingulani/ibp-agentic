/**
 * Harness V0 — utilitários compartilhados (L1 pins, L2 smoke, L3 report).
 * Sem rede e sem banco: só filesystem + git. Ver docs/architecture/HARNESS.md.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const MD5_RE = /^[0-9a-f]{32}$/;

export type Pin = { path: string; md5: string };

export function md5Text(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

export function md5Bytes(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex");
}

/** Path relativo ao repo, sem `..`. Digest dos bytes do arquivo (igual a `md5sum`). */
export function md5File(rel: string): string {
  if (rel.startsWith("/") || rel.split("/").includes("..")) throw new Error(`pin path inválido: ${rel}`);
  return md5Bytes(readFileSync(resolve(repoRoot, rel)));
}

export function loadPins(): Pin[] {
  const raw: unknown = JSON.parse(readFileSync(resolve(repoRoot, "harness/pins.json"), "utf8"));
  const pins = (raw as { pins?: unknown }).pins;
  if (!Array.isArray(pins) || pins.length === 0) throw new Error("harness/pins.json: pins[] vazio");
  const seen = new Set<string>();
  for (const p of pins) {
    const path = (p as { path?: unknown }).path;
    const md5 = (p as { md5?: unknown }).md5;
    if (typeof path !== "string" || path.length === 0) throw new Error("harness/pins.json: path inválido");
    if (typeof md5 !== "string" || !MD5_RE.test(md5)) throw new Error(`harness/pins.json: md5 inválido em ${path}`);
    if (seen.has(path)) throw new Error(`harness/pins.json: path duplicado ${path}`);
    seen.add(path);
  }
  return pins as Pin[];
}

export function pinByPath(rel: string): Pin | undefined {
  return loadPins().find((p) => p.path === rel);
}

/** `git rev-parse HEAD` — 40 hex. */
export function gitSha(): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const sha = (r.stdout ?? "").trim();
  if (r.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error((r.stderr || "git rev-parse HEAD falhou").trim());
  }
  return sha;
}
