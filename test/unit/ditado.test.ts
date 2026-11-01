// W2 ditado service (unit, sem rede): timeout, teto diário, cache por (tenant, texto), validação.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DitadoService, DitadoUnavailable, ditadoCacheKey, httpDitadoLlmFromEnv, validateLlmCards } from "../../src/wizard/ditado.js";

const ctx = { tenantId: "t1", nodes: [{ stable_id: "11111111-1111-4111-8111-111111111111", code: "CD3", name: "CD", node_type: null }] };

test("timeout → DitadoUnavailable(timeout)", async () => {
  const s = new DitadoService({ extract: (_t, _c, signal) => new Promise((_r, rej) => signal.addEventListener("abort", () => rej(signal.reason))) }, { timeoutMs: 30 });
  await assert.rejects(s.extract("x", ctx), (e) => e instanceof DitadoUnavailable && e.reason === "timeout");
});

test("daily cap → budget_cap; cache hit does not count", async () => {
  let n = 0;
  const s = new DitadoService({ async extract() { n++; return { cards: [] }; } }, { dailyCap: 1 });
  await s.extract("a", ctx);
  assert.equal((await s.extract("A ", ctx)).cached, true);
  await assert.rejects(s.extract("b", ctx), (e) => e instanceof DitadoUnavailable && e.reason === "budget_cap");
  assert.equal(n, 1);
});

test("cache key separates tenants; null provider → not_configured; env without vars → no provider", async () => {
  assert.notEqual(ditadoCacheKey("t1", "x"), ditadoCacheKey("t2", "x"));
  assert.equal(ditadoCacheKey("t1", " X  y"), ditadoCacheKey("t1", "x y"));
  await assert.rejects(new DitadoService(null).extract("x", ctx), (e) => e instanceof DitadoUnavailable && e.reason === "not_configured");
  assert.equal(httpDitadoLlmFromEnv({}), null);
});

test("validateLlmCards resolves code/stable_id and rejects Gap without current node", () => {
  const { cards, rejected } = validateLlmCards({ cards: [
    { type: "Gap", fields: {}, nodeRef: "cd3" },
    { type: "Gap", fields: {}, links: { nodeId: ctx.nodes[0].stable_id } },
    { type: "Gap", fields: {}, nodeRef: "X" },
    { type: "CurvaDemanda", fields: { a: 1 }, status: "gap" },
  ] }, ctx);
  assert.deepEqual(cards.map((c) => [c.type, c.node_id, c.status, c.source]), [
    ["Gap", ctx.nodes[0].stable_id, "gap", "ditado"], ["Gap", ctx.nodes[0].stable_id, "gap", "ditado"], ["CurvaDemanda", null, "gap", "ditado"]]);
  assert.deepEqual(rejected.map((r) => [r.index, r.reason]), [[2, "invalid_reference"]]);
  assert.equal(validateLlmCards({ nope: 1 }, ctx).rejected[0].reason, "invalid_output");
});
