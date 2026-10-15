/**
 * The whole pipeline: a request becomes a manifest whose content hash
 * identifies the town, every validation gate passes or the generation fails
 * with the stage that broke, and the event log says what was decided.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_RULES, contentHash, generateSettlement, GENERATOR_VERSION } from "../src/index.js";

const request = { settlementId: "0182", seed: 1234, population: 600 };

function must(r: ReturnType<typeof generateSettlement>) {
  assert.ok(r.ok, r.ok ? "" : `${r.error.stage}: ${r.error.message}`);
  return r;
}

describe("generateSettlement", () => {
  const { manifest, events } = must(generateSettlement({ ...request, verbosity: "verbose" }));

  it("emits a versioned manifest whose hash covers everything else", () => {
    assert.equal(manifest.format, "mmo-settlement/1");
    assert.equal(manifest.generatorVersion, GENERATOR_VERSION);
    assert.equal(manifest.rulesVersion, BUILTIN_RULES.version);
    const { hash, ...rest } = manifest;
    assert.equal(hash, contentHash(rest));
  });

  it("is reproducible: the same request gives the same hash, another seed another town", () => {
    assert.equal(must(generateSettlement(request)).manifest.hash, manifest.hash);
    assert.notEqual(must(generateSettlement({ ...request, seed: 99 })).manifest.hash, manifest.hash);
  });

  it("pins the golden hash, so any change to the generator's output is a visible decision", () => {
    assert.equal(manifest.hash, GOLDEN);
  });

  it("passes every validation gate", () => {
    assert.ok(manifest.validation.length >= 6);
    for (const g of manifest.validation) assert.ok(g.ok, `${g.gate}: ${g.detail}`);
  });

  it("holds its tables in id order, with no wall-clock or random state in them", () => {
    for (const table of [manifest.districts, manifest.parcels, manifest.structures] as { id: string }[][]) {
      assert.deepEqual(table.map((r) => r.id), [...table.map((r) => r.id)].sort());
    }
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(JSON.stringify(manifest)), "no ISO timestamps");
  });

  it("logs a summary event per stage, and a collapse per parcel at verbose", () => {
    assert.deepEqual(events.filter((e) => e.level === "summary").map((e) => e.stage), ["demographics", "demand", "layout", "structures", "validation"]);
    assert.equal(events.filter((e) => e.event === "structure_collapsed").length, manifest.parcels.length);
  });

  it("keeps only what the verbosity asks for (silent: nothing)", () => {
    assert.deepEqual(must(generateSettlement({ ...request, verbosity: "silent" })).events, []);
    assert.equal(must(generateSettlement({ ...request, verbosity: "summary" })).events.length, 5);
  });

  it("fails with the stage and reason when the demand cannot be met", () => {
    const rules = structuredClone(BUILTIN_RULES);
    rules.required.market = { min: 9999 };
    const r = generateSettlement({ ...request, rules });
    assert.ok(!r.ok);
    assert.equal(r.error.stage, "structures");
  });

  it("refuses a request that makes no sense", () => {
    const r = generateSettlement({ ...request, population: 0 });
    assert.ok(!r.ok);
    assert.equal(r.error.stage, "request");
  });
});

const GOLDEN = "9af84d1679625c93eea33585fe3f52c8b5cfe2c8b156c78e9194d28e1b749db4";
