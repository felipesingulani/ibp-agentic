// T-DM-PERIOD-GRAIN + T-DM-SALESHIST-UQ — borda zod (≡ CHECKs da 0018).
import assert from "node:assert/strict";
import { test } from "node:test";
import { YM_RE, entityByPath } from "../../src/domain/entities.js";

const schema = entityByPath.get("sales_history")!.schema;
const base = { node_id: "00000000-0000-4000-8000-000000000001", sku_id: "00000000-0000-4000-8000-000000000002", qty: 1 };

test("T-DM-PERIOD-GRAIN zod: só YYYY-MM; dia/formatos tortos rejeitados", () => {
  for (const ok of ["2026-10", "2026-01", "2026-12", "1999-07"]) {
    assert.equal(schema.safeParse({ ...base, period: ok }).success, true, ok);
  }
  for (const bad of ["2026-10-15", "2026-10-01", "202610", "2026/10", "2026-13", "2026-00", "2026-1", "", " 2026-10", "2026-10 "]) {
    const r = schema.safeParse({ ...base, period: bad });
    assert.equal(r.success, false, bad);
    assert.deepEqual(r.error!.issues[0].path, ["period"]);
  }
});

test("T-DM-PERIOD-GRAIN: regex zod ≡ CHECK SQL sales_history_period_ym (0018)", async () => {
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync("db/migrations/0018_sales_history_period_grain_unique.sql", "utf8");
  assert.ok(sql.includes(`period ~ '${YM_RE.source}'`), "CHECK SQL diverge do YM_RE");
});

test("T-DM-SALESHIST-UQ zod: qty >= 0 (0 ok, negativo 400)", () => {
  assert.equal(schema.safeParse({ ...base, period: "2026-10", qty: 0 }).success, true);
  const r = schema.safeParse({ ...base, period: "2026-10", qty: -1 });
  assert.equal(r.success, false);
  assert.deepEqual(r.error!.issues[0].path, ["qty"]);
});
