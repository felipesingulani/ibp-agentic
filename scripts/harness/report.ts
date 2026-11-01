/**
 * L3 — relatório de aceite. Não chama a API e não falha por checkbox aberto
 * (os QA-ACCEPTANCE nascem desmarcados; Qualidade marca depois).
 *
 * md5 do checklist = md5 da concatenação, em ordem de path, dos bytes de
 * `docs/architecture/QA-ACCEPTANCE*.md` (igual a `cat` desses arquivos | md5sum).
 *
 * Linha DoD (SHA + md5): `DOD <sha40> <checklist_md5>`
 * Smoke: env HARNESS_SMOKE_MD5 (a linha SMOKE_MD5 do L2). Ausente imprime `-`.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitSha, repoRoot } from "./lib.js";

const dir = join(repoRoot, "docs/architecture");
const files = readdirSync(dir).filter((f) => f.startsWith("QA-ACCEPTANCE") && f.endsWith(".md")).sort();
if (files.length === 0) {
  console.error("report: nenhum docs/architecture/QA-ACCEPTANCE*.md");
  process.exit(1);
}

const smoke = (process.env.HARNESS_SMOKE_MD5 ?? "").trim();
if (smoke && !/^[0-9a-f]{32}$/.test(smoke)) {
  console.error("HARNESS_SMOKE_MD5 inválido (esperado 32 hex)");
  process.exit(1);
}

const hash = createHash("md5");
let openTotal = 0;
let doneTotal = 0;
const blocks: string[] = [];

for (const f of files) {
  const bytes = readFileSync(join(dir, f));
  hash.update(bytes);
  const open: string[] = [];
  const done: string[] = [];
  for (const line of bytes.toString("utf8").split("\n")) {
    const m = /^- \[([ xX])\]\s*(.*)$/.exec(line);
    if (!m) continue;
    (m[1] === " " ? open : done).push(m[2].trim());
  }
  openTotal += open.length;
  doneTotal += done.length;
  const lines = [`${f}  open=${open.length} checked=${done.length}`];
  for (const item of open) lines.push(`  - [ ] ${item}`);
  blocks.push(lines.join("\n"));
}

const checklistMd5 = hash.digest("hex");
const sha = gitSha();

console.log("harness L3");
console.log(`sha ${sha}`);
console.log(`checklist_md5 ${checklistMd5}`);
console.log(`smoke_md5 ${smoke || "-"}`);
console.log(`files ${files.length}  open=${openTotal} checked=${doneTotal}`);
console.log(blocks.join("\n"));
console.log(`DOD ${sha} ${checklistMd5}`);
