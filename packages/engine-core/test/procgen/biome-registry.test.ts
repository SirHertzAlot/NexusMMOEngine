/**
 * Biome registry (open-world plan, Phase 5): the shipped registry covers the
 * default world's biomes and the wilds plan's groups; its scatter rows are
 * the multipliers the ecology reads; packs are planned per chunk,
 * deterministically, at the biome's density; WildCreatures spawns a chunk's
 * packs on load and removes them on unload.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SimWorld } from "../../src/world.js";
import { CreatureSystem } from "../../src/creatures.js";
import { loadGameRules } from "../../src/rules/boot.js";
import { loadEcologyPlan } from "../../src/procgen/ecology.js";
import { DEFAULT_ECOLOGY_PLAN } from "../../src/procgen/world-populator.js";
import {
  applyBiomeScatter,
  checkBiomeRegistry,
  ecologyGroups,
  loadBiomeRegistry,
  parseBiomeRegistry,
  planChunkPacks,
  type BiomeRegistry,
} from "../../src/procgen/biome-registry.js";
import { WildCreatures } from "../../src/procgen/wild-creatures.js";

const game = loadGameRules();
const { registry } = loadBiomeRegistry();
const worldSpec = JSON.parse(readFileSync(fileURLToPath(new URL("../../../worlds/default.world.json", import.meta.url)), "utf8")) as {
  biomes: { id: string }[];
};
// The species roster's ids (@mmo-engine/species BUILTIN_SPECIES) that live in the open world.
const SPECIES = ["goblin", "orc", "troll", "ogre", "wolf", "bear", "boar", "giant-spider"];

function registryOf(biomes: Record<string, unknown>): BiomeRegistry {
  return parseBiomeRegistry({ version: 1, biomes });
}

describe("biome registry", () => {
  it("the shipped registry covers the default world, the wilds plan's groups and known kinds", () => {
    const { plan } = loadEcologyPlan(DEFAULT_ECOLOGY_PLAN);
    const problems = checkBiomeRegistry(registry, {
      worldBiomes: worldSpec.biomes.map((b) => b.id),
      scatterGroups: ecologyGroups(plan),
      kinds: [...new Set([...SPECIES, ...Object.keys(game.rules.creatures.creatures)])],
    });
    assert.deepEqual(problems, []);
  });

  it("names every problem: missing and extra biomes, unknown groups and kinds, duplicates, density without a table", () => {
    const r = registryOf({
      forest: { name: "Forest", scatter: { trees: 1, lasers: 2 }, creatures: { packsPerKm2: 5, table: [{ kind: "goblin", weight: 1 }, { kind: "goblin", weight: 2 }, { kind: "dragon", weight: 1 }] } },
      moon: { name: "Moon", creatures: { packsPerKm2: 3, table: [] } },
    });
    const problems = checkBiomeRegistry(r, { worldBiomes: ["forest", "sea"], scatterGroups: ["trees"], kinds: ["goblin"] });
    for (const want of [/world biome "sea" has no entry/, /"moon" is not a biome/, /group "lasers"/, /"goblin" listed twice/, /unknown kind "dragon"/, /moon.creatures: 3 packs per km² but an empty table/]) {
      assert.ok(problems.some((p) => want.test(p)), `${want} in ${problems.join(" | ")}`);
    }
  });

  it("refuses a malformed file with the path of each problem", () => {
    assert.throws(() => parseBiomeRegistry({ version: 1, biomes: { Forest: { name: "" } } }), /biomes\.Forest/);
    assert.throws(
      () => parseBiomeRegistry({ version: 1, biomes: { forest: { name: "F", creatures: { packsPerKm2: 1, table: [{ kind: "goblin", weight: 1, pack: [4, 2] }] } } } }),
      /pack: min above max/,
    );
    assert.throws(() => parseBiomeRegistry({ version: 2, biomes: {} }), /version/);
  });

  it("scatter rows overlay the plan's default row, and the hash follows the multipliers", () => {
    const { plan, hash } = loadEcologyPlan(DEFAULT_ECOLOGY_PLAN);
    const applied = applyBiomeScatter(plan, hash, registry);
    // The sea lists two groups; the rest come from the default row.
    assert.equal(applied.plan.biomes.sea.reeds, 0.1);
    assert.equal(applied.plan.biomes.sea.trees, plan.biomes.default.trees);
    assert.equal(applied.plan.biomes.volcanic.trees, 0);
    assert.equal(applied.plan.biomes.rainforest.understory, 1.7);
    assert.deepEqual(applied.plan.biomes.default, plan.biomes.default);
    assert.notEqual(applied.hash, hash);
    assert.equal(applyBiomeScatter(plan, hash, registry).hash, applied.hash, "stable");
    const tweaked = structuredClone(registry);
    tweaked.biomes.forest.scatter.trees = 0.9;
    assert.notEqual(applyBiomeScatter(plan, hash, tweaked).hash, applied.hash);
  });

  it("plans at most one pack per chunk, deterministically, at about the biome's density", () => {
    const r = registryOf({
      forest: { name: "Forest", creatures: { packsPerKm2: 400, table: [{ kind: "goblin", weight: 3 }, { kind: "wolf", weight: 1, pack: [3, 5] }] } },
      sea: { name: "Sea" },
    });
    const ctx = (cx: number, cz: number, biome = "forest") => ({ seed: 99, cx, cz, chunkWorldSize: 16, biomeAt: () => biome });
    let packs = 0;
    const kinds = new Map<string, number>();
    const N = 200;
    for (let cx = 0; cx < N; cx++) {
      for (let cz = 0; cz < N; cz++) {
        const p = planChunkPacks(r, ctx(cx, cz));
        assert.ok(p.length <= 1);
        for (const pk of p) {
          packs++;
          kinds.set(pk.kind, (kinds.get(pk.kind) ?? 0) + 1);
          assert.ok(pk.x >= cx * 16 && pk.x < (cx + 1) * 16 && pk.z >= cz * 16 && pk.z < (cz + 1) * 16, "inside its chunk");
          if (pk.kind === "wolf") assert.deepEqual(pk.pack, [3, 5]);
        }
      }
    }
    // 400 per km² over 40,000 chunks of 256 m²: 4,096 expected.
    const expected = (400 * 256 * N * N) / 1e6;
    assert.ok(Math.abs(packs - expected) < expected * 0.1, `${packs} packs, ~${expected} expected`);
    const goblinShare = (kinds.get("goblin") ?? 0) / packs;
    assert.ok(Math.abs(goblinShare - 0.75) < 0.05, `goblin share ${goblinShare}`);
    assert.deepEqual(planChunkPacks(r, ctx(7, 3)), planChunkPacks(r, ctx(7, 3)));
    for (let cx = 0; cx < 50; cx++) assert.deepEqual(planChunkPacks(r, ctx(cx, 0, "sea")), [], "nothing lives in the sea");
    assert.deepEqual(planChunkPacks(r, { ...ctx(0, 0), biomeAt: () => null }), []);
  });

  it("kinds that can't spawn yet keep their share: fewer packs, not more of the others", () => {
    const r = registryOf({ forest: { name: "Forest", creatures: { packsPerKm2: 4000, table: [{ kind: "goblin", weight: 1 }, { kind: "wolf", weight: 1 }] } } });
    let all = 0;
    let goblinsOnly = 0;
    for (let cx = 0; cx < 100; cx++) {
      const base = { seed: 5, cx, cz: 0, chunkWorldSize: 16, biomeAt: () => "forest" };
      const every = planChunkPacks(r, base);
      const some = planChunkPacks(r, { ...base, spawnable: (k) => k === "goblin" });
      all += every.length;
      goblinsOnly += some.length;
      assert.deepEqual(some, every.filter((p) => p.kind === "goblin"));
    }
    assert.ok(goblinsOnly < all * 0.7, `${goblinsOnly} of ${all}`);
  });
});

describe("wild creatures", () => {
  it("spawns a chunk's packs when it loads and removes them when it unloads", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const creatures = new CreatureSystem({ creatures: game.rules.creatures.creatures, bases: game.rules.items.bases });
    const r = registryOf({ forest: { name: "Forest", creatures: { packsPerKm2: 1e6 / 256, table: [{ kind: "goblin", weight: 1, pack: [2, 2] }] } } });
    const wild = new WildCreatures({ registry: r, spawner: creatures, seed: 1, chunkWorldSize: 16, biomeAt: () => "forest" });
    sim.beginTick(1);
    wild.load(sim, 0, 0);
    wild.load(sim, 0, 0); // a second load of a loaded chunk adds nothing
    wild.load(sim, 1, 0);
    assert.equal(creatures.size, 4);
    assert.deepEqual(wild.stats(), { packs: 2, creatures: 4, spawned: 2, removed: 0 });
    wild.unload(sim, 0, 0);
    sim.endTick();
    sim.beginTick(2);
    creatures.step(sim); // forgets despawned bodies
    sim.endTick();
    assert.equal(creatures.size, 2);
    assert.deepEqual(wild.stats(), { packs: 1, creatures: 2, spawned: 2, removed: 1 });
  });

  it("skips blocked spots and kinds without creature rules", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const creatures = new CreatureSystem({ creatures: game.rules.creatures.creatures, bases: game.rules.items.bases });
    const dense = { packsPerKm2: 1e6 / 256 };
    const wolves = new WildCreatures({
      registry: registryOf({ forest: { name: "Forest", creatures: { ...dense, table: [{ kind: "wolf", weight: 1 }] } } }),
      spawner: creatures, seed: 1, chunkWorldSize: 16, biomeAt: () => "forest",
    });
    const wet = new WildCreatures({
      registry: registryOf({ forest: { name: "Forest", creatures: { ...dense, table: [{ kind: "goblin", weight: 1 }] } } }),
      spawner: creatures, seed: 1, chunkWorldSize: 16, biomeAt: () => "forest", blocked: () => true,
    });
    sim.beginTick(1);
    for (let cx = 0; cx < 5; cx++) {
      wolves.load(sim, cx, 0);
      wet.load(sim, cx, 0);
    }
    sim.endTick();
    assert.equal(creatures.size, 0);
  });
});
