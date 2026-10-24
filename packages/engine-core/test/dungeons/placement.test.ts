/**
 * Chests and traps (placement.ts) land on free, walkable cells: never on each
 * other, never inside a baked prop's footprint or collider, the same every
 * time for a layout; and a run stands a chest entity at each chest, swapped
 * for an open one when it is opened.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defineQuery } from "bitecs";
import { fnv1a32 } from "@mmo-engine/picg";
import { BUILTIN_DRESSING, BUILTIN_THEMES, dressDungeon, encodeDungeon, generateDungeon } from "@mmo-engine/dungeon";
import * as C from "../../src/components.js";
import { SimWorld } from "../../src/world.js";
import { MemoryCharacterStore } from "../../src/index.js";
import { loadGameRules } from "../../src/rules/boot.js";
import { loadDungeonContent } from "../../src/dungeons/content.js";
import { readLayout, walkableAt } from "../../src/dungeons/pool.js";
import { CHEST_KINDS, footprint, placeChestsAndTraps, SPACING_M } from "../../src/dungeons/placement.js";
import { DungeonInstance } from "../../src/dungeons/instance.js";
import { makeCredentialStore } from "../net/auth-harness.js";

const content = loadDungeonContent();
const bake = (seed: number, theme: string) => {
  const d = generateDungeon({ seed, rooms: 14, loopChance: 0.15, decorDensity: 0.6, theme }, BUILTIN_THEMES[theme]);
  return readLayout(JSON.parse(JSON.stringify(encodeDungeon(d, dressDungeon(d, BUILTIN_DRESSING, 2)))));
};

describe("chest and trap placement", () => {
  for (const [seed, theme] of [[77, "grim"], [3, "molten"], [91, "frost"], [1234, "grim"], [5, "frost"]] as const) {
    it(`keeps chests and traps apart and clear of props (${theme} ${seed})`, () => {
      const l = bake(seed, theme);
      const { chests, traps } = placeChestsAndTraps(l, 3, 2, content.props);
      assert.equal(chests.length, 3);
      assert.equal(traps.length, 2);
      const all = [...chests, ...traps];
      for (let i = 0; i < all.length; i++) {
        assert.ok(walkableAt(l, all[i].x, all[i].z), "walkable");
        for (let j = i + 1; j < all.length; j++) assert.ok(Math.hypot(all[i].x - all[j].x, all[i].z - all[j].z) >= SPACING_M - 1e-9, `${i} and ${j} too close`);
      }
      for (const t of [...traps, ...chests.filter((c) => c.prop === undefined)]) {
        l.props.forEach((p) => assert.ok(Math.hypot(p.x - t.x, p.z - t.z) >= footprint(p, content.props), `inside a ${p.kind}`));
        for (let k = 0; k < l.colliders.length; k += 3) assert.ok(Math.hypot(l.colliders[k] - t.x, l.colliders[k + 1] - t.z) >= l.colliders[k + 2], "inside a collider");
      }
      for (const c of chests) if (c.prop !== undefined) assert.ok(CHEST_KINDS.has(l.props[c.prop].kind));
      assert.deepEqual(placeChestsAndTraps(l, 3, 2, content.props), { chests, traps }, "the same every time");
    });
  }

  it("stands a chest entity at each placed chest (a baked chest is used once, not doubled as dressing)", async () => {
    SimWorld.resetEntityCursorForTesting();
    const characters = new MemoryCharacterStore();
    const layout = bake(77, "grim");
    const inst = new DungeonInstance({
      id: "run-chest-entity", entrance: "barrow-gate", layout, rules: content.rules, props: content.props, game: loadGameRules(),
      members: [], credentialStore: await makeCredentialStore(), characterStore: characters,
      chestPool: [11], onEnd: () => {}, now: () => 2_000_000, clock: () => Date.now(), transport: "ws",
    });
    try {
      const placed = placeChestsAndTraps(layout, content.rules.chestsPerRun, content.rules.trapsPerRun, content.props);
      assert.equal(inst.chests.length, placed.chests.length);
      const near = (e: number, x: number, z: number) => Math.hypot(C.Transform.px[e] - x, C.Transform.pz[e] - z) < 1e-3;
      const chestAssets = new Set([fnv1a32("dungeon:chest"), fnv1a32("dungeon:gilded-chest")]);
      const standing = [...defineQuery([C.AssetRef])(inst.world.ecs)].filter((e) => chestAssets.has(C.AssetRef.assetHash[e]));
      for (const ch of inst.chests) assert.equal(standing.filter((e) => near(e, ch.x, ch.z)).length, 1, `exactly one chest entity at ${ch.id}`);
      assert.deepEqual(inst.traps.map((t) => [t.x, t.z]), placed.traps.map((t) => [t.x, t.z]));
    } finally {
      await inst.close();
    }
  });
});
