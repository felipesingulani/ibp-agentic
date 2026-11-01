// W5 · Task 11 — regras puras: latência (mediana/máx, sem par → no_data), pontos de alavanca (expedite nunca inventa $),
// roles (roster tenant › pack, gaps), templates pt-BR só com números do snapshot (null → "—" + motivo).
import assert from "node:assert/strict";
import { test } from "node:test";
import { latencyOf, leveragePoints, median, rolesOf } from "../../src/journey/snapshot.js";
import { buildPack, fmtKpi, renderMarkdown } from "../../src/journey/conviction.js";
import { initialSteps, landSchema, normScope } from "../../src/journey/contract.js";
import type { Kpi } from "../../src/w3/kpi.js";

const k = (key: string, value: number | null, unit: string | null, nullReason: Kpi["nullReason"] = null): Kpi =>
  ({ key, label: key.toUpperCase(), value, unit, nullReason, source: `src:${key}` });

test("median/latencyOf: sem pares → null + no_data; com pares → mediana e máx (2 casas)", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.deepEqual({ ...latencyOf([]), source: "" }, { pairs: 0, medianHours: null, maxHours: null, nullReason: "no_data", source: "" });
  const l = latencyOf([1.234, 10, 2.5]);
  assert.deepEqual([l.pairs, l.medianHours, l.maxHours, l.nullReason], [3, 2.5, 10, null]);
});

test("leveragePoints: ordem wc/svc/expedite/cost/adherence; expedite null (no_plan sem plano, not_computed_v0 com plano)", () => {
  const kpis = [k("svc", 0.9, "ratio"), k("cost", 3, "BRL/t"), k("viol", 0, "count"), k("wc", null, "BRL mi", "not_computed_v0")];
  const p = leveragePoints(kpis, k("adherence", null, "ratio", "no_data"), "approved", "BRL");
  assert.deepEqual(p.map((x) => x.key), ["wc", "svc", "expedite", "cost", "adherence"]);
  assert.deepEqual([p[2].value, p[2].nullReason, p[2].unit], [null, "not_computed_v0", "BRL mi"]);
  const none = leveragePoints(kpis, k("adherence", null, "ratio", "no_plan"), "none", null);
  assert.deepEqual([none[2].nullReason, none[2].unit], ["no_plan", null]);
});

test("rolesOf: roster do pack + override do tenant; gaps = papéis com 0 usuários", () => {
  const r = rolesOf({ industry_pack: null, agent_roster: { A7: { enabled: false } } }, new Map([["finance", 2], ["admin", 1]]), "finance");
  assert.equal(r.pack, "generic");
  assert.equal(r.agents.find((a) => a.id === "A7")!.enabled, false);
  assert.deepEqual(r.users, { domain_owner: 0, sales: 0, supply: 0, finance: 2 });
  assert.deepEqual(r.gaps, ["domain_owner", "sales", "supply"]);
  assert.equal(r.sponsorRole, "finance");
});

test("fmtKpi: null → '—' + motivo pt-BR; ratio → %; unidade anexada", () => {
  assert.equal(fmtKpi(k("wc", null, "BRL mi", "not_computed_v0")), "— (não calculado na V0)");
  assert.equal(fmtKpi(k("svc", null, "ratio", "no_plan")), "— (sem plano — rode o A4)");
  assert.equal(fmtKpi(k("svc", 0.9, "ratio")), "90%");
  assert.equal(fmtKpi(k("cost", 1234.5, "BRL/t")), "1.234,5 BRL/t");
});

test("renderMarkdown: lab vazio não mostra número falso; todo número do MD vem do snapshot", () => {
  const snapshot = {
    takenAt: "2026-10-30T06:00:00.000Z", scope: normScope(undefined), scopeFilter: "tenant_v0" as const,
    planRef: { basis: "none", scenarioId: null, scenarioVersion: null, runId: null, at: null },
    leverage: { points: [k("wc", null, null, "not_computed_v0"), k("svc", null, "ratio", "no_plan"), k("expedite", null, null, "no_plan"),
      k("cost", null, null, "no_plan"), k("adherence", null, "ratio", "no_plan")], exceptions: { block: 0, warn: 0, info: 0 } },
    consensus: { decisions: { approve: 0, escalate: 0, total: 0 }, latency: latencyOf([]), pendingAlcada: 0 },
    roles: rolesOf(undefined, new Map(), null),
  };
  const pack = buildPack({ tenantId: "t1", id: "j1", code: "JR-0001", sponsorRole: null, scope: snapshot.scope,
    steps: initialSteps(), snapshot, now: new Date("2026-10-30T06:01:00Z") });
  const md = renderMarkdown(pack);
  assert.match(md, /# Conviction pack — JR-0001/);
  assert.match(md, /Base do plano: sem plano/);
  assert.equal((md.match(/— \(sem plano — rode o A4\)/g) ?? []).length, 4);
  assert.match(md, /mediana — \(sem dado\)/);
  assert.match(md, /Lacunas de papel: Dono do domínio, Vendas, Supply, Finanças/);
  // tabela de alavancas sem nenhum dígito (nada inventado)
  const table = md.split("## 1. Alavancas")[1].split("Exceções")[0];
  assert.doesNotMatch(table.replace(/src:\w+|A4|V0/g, ""), /\d/);
});

test("landSchema: landTenantId não combina com slug/name; strict", () => {
  assert.ok(landSchema.safeParse({}).success);
  assert.ok(landSchema.safeParse({ slug: "land-x1" }).success);
  assert.ok(!landSchema.safeParse({ landTenantId: "00000000-0000-4000-8000-000000000000", slug: "x1" }).success);
  assert.ok(!landSchema.safeParse({ extra: 1 }).success);
  assert.ok(!landSchema.safeParse({ slug: "Bad Slug" }).success);
});
