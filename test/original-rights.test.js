import test from "node:test";
import assert from "node:assert/strict";
import { createOriginalBrief, detectFormat } from "../src/original.js";
import { validateRights, assertSourcesCleared } from "../src/rights.js";

test("original brief follows the format, never the footage", () => {
  const b = createOriginalBrief({ title: "Cheapest vs most expensive villa", durationSeconds: 50 }, { topic: "luxury villas" });
  assert.equal(b.format, "Comparison (A vs B)");
  assert.equal(b.orientation, "vertical 9:16");
  assert.equal(b.hooks.length, 3);
  assert.equal(b.generatedBy, "template");
  assert.ok(b.rightsGuardrails.some((g) => /Do not reuse/.test(g)));
  assert.equal(b.beats.at(-1).until, b.targetSeconds);
});

test("format detection", () => {
  assert.equal(detectFormat("I tried cooking for 7 days").key, "challenge");
  assert.equal(detectFormat("5 tips for travel").key, "list");
  assert.equal(detectFormat("Something calm").key, "generic");
});

test("rights validation", () => {
  assert.deepEqual(validateRights({ basis: "own", holder: "Me", confirmed: "true" }), []);
  assert.ok(validateRights({ basis: "licensed", holder: "Me", confirmed: true }).some((e) => /evidence/.test(e)));
  assert.ok(validateRights({ basis: "own", holder: "Me" }).some((e) => /confirm/.test(e)));
  assert.ok(validateRights({ basis: "found-it-online", holder: "Me", confirmed: true }).length);
  assert.ok(validateRights({ basis: "cc_by", holder: "Blender Foundation", evidence: "https://creativecommons.org/licenses/by/3.0/", confirmed: true }).some((e) => /attribution/.test(e)));
  assert.deepEqual(validateRights({ basis: "cc_by", holder: "Blender Foundation", evidence: "https://creativecommons.org/licenses/by/3.0/", attribution: "(c) 2008 Blender Foundation", confirmed: true }), []);
  assert.throws(() => assertSourcesCleared({ rights: [{ sourceId: "a" }] }, ["a", "b"]), /b/);
});
