/**
 * TDD: EA22 particle tier budgets.
 *
 * `content/vfx/budgets.json`: per-quality-tier particle budgets
 * (max particles, max emitters). The client scales emission to the
 * active tier; tuning a budget is a JSON edit, never code.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadParticleBudgets, budgetForTier } from "../src/particle-budgets.js";

const VALID = {
  version: 1,
  tiers: {
    low: { maxParticles: 1000, maxEmitters: 8 },
    medium: { maxParticles: 2500, maxEmitters: 16 },
    high: { maxParticles: 5000, maxEmitters: 32 },
    ultra: { maxParticles: 8000, maxEmitters: 48 },
  },
};

describe("loadParticleBudgets", () => {
  it("loads a valid budget file", () => {
    const b = loadParticleBudgets(VALID);
    assert.equal(b.tiers.low.maxParticles, 1000);
    assert.equal(b.tiers.ultra.maxEmitters, 48);
  });

  it("rejects a missing tier", () => {
    const bad = { ...VALID, tiers: { ...VALID.tiers } };
    delete (bad.tiers as Record<string, unknown>).low;
    assert.throws(() => loadParticleBudgets(bad), /low/);
  });

  it("rejects a non-positive particle count", () => {
    const bad = JSON.parse(JSON.stringify(VALID));
    bad.tiers.low.maxParticles = 0;
    assert.throws(() => loadParticleBudgets(bad), /maxParticles/);
  });

  it("rejects an unknown tier name", () => {
    const bad = JSON.parse(JSON.stringify(VALID));
    bad.tiers.potato = { maxParticles: 1, maxEmitters: 1 };
    assert.throws(() => loadParticleBudgets(bad), /tier/);
  });
});

describe("budgetForTier", () => {
  it("returns the tier's budget", () => {
    const b = loadParticleBudgets(VALID);
    assert.equal(budgetForTier(b, "medium").maxParticles, 2500);
  });

  it("budgets are monotonic across tiers", () => {
    const b = loadParticleBudgets(VALID);
    const counts = (["low", "medium", "high", "ultra"] as const).map((t) => budgetForTier(b, t).maxParticles);
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i] >= counts[i - 1], `tier ${i} should not shrink the budget`);
    }
  });

  it("DEFAULT_PARTICLE_BUDGETS matches content/vfx/budgets.json", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // test file is at packages/art/dist/test/, repo root is 4 up
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    const json = JSON.parse(readFileSync(join(root, "content", "vfx", "budgets.json"), "utf8"));
    const { DEFAULT_PARTICLE_BUDGETS } = await import("../src/particle-budgets.js");
    assert.deepEqual(DEFAULT_PARTICLE_BUDGETS, loadParticleBudgets(json));
  });
});
