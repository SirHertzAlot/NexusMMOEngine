/**
 * Room interiors at runtime: the bake's interiors reach the instance's layout, and each
 * part maps to a static entity at its room's origin, carrying the hash of the model it names.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineQuery } from "bitecs";
import { fnv1a32 } from "@mmo-engine/picg";
import {
  BUILTIN_DRESSING, BUILTIN_THEMES, dressDungeon, encodeDungeon, generateDungeon, loadInteriorContent, roomInteriors,
  type RoomInterior,
} from "@mmo-engine/dungeon";
import * as C from "../../src/components.js";
import { MemoryCharacterStore } from "../../src/index.js";
import { loadGameRules } from "../../src/rules/boot.js";
import { loadDungeonContent } from "../../src/dungeons/content.js";
import { DungeonInstance } from "../../src/dungeons/instance.js";
import { CELL_M, readLayout, type InstanceLayout } from "../../src/dungeons/pool.js";
import { interiorSpawns, type InteriorSpawn } from "../../src/dungeons/interiors.js";
import { makeCredentialStore } from "../net/auth-harness.js";

const content = loadInteriorContent(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../content/synthesis"));
const TOL = 1e-6;
/** Transform fields are float32 in the world, so a stored value sits within this of its spawn. */
const STORE_TOL = 1e-4;
const game = loadGameRules();
const dungeonContent = loadDungeonContent(undefined, false);

/** A grim dungeon from `seed`, baked as the bake writes it, with its interiors laid when `laid` is set. */
function bake(seed: number, laid: boolean): { file: unknown; interiors: RoomInterior[] } {
  const d = generateDungeon({ seed, rooms: 34, loopChance: 0.2, decorDensity: 0.5, theme: "grim" }, BUILTIN_THEMES.grim);
  const dressing = dressDungeon(d, BUILTIN_DRESSING, 3);
  const interiors = laid ? roomInteriors(d, dressing.archetypes, BUILTIN_DRESSING, content.styles, content.ruleSet, seed) : [];
  return { file: JSON.parse(JSON.stringify(encodeDungeon(d, dressing, undefined, laid ? interiors : undefined))), interiors };
}

/** The first grim dungeon, from seed 1, whose dressing lays an interior. */
function laidDungeon(): { file: unknown; interiors: RoomInterior[] } {
  for (let seed = 1; seed <= 40; seed++) {
    const baked = bake(seed, true);
    if (baked.interiors.length > 0) return baked;
  }
  throw new Error("no grim dungeon in 40 seeds lays an interior");
}

/** A run of the layout, built but not started: its interior parts are spawned on construction. */
async function instanceOf(layout: InstanceLayout): Promise<DungeonInstance> {
  return new DungeonInstance({
    id: "run-interiors", entrance: "barrow-gate", layout, rules: dungeonContent.rules, game,
    members: [], credentialStore: await makeCredentialStore(), characterStore: new MemoryCharacterStore(),
    lootPool: [7, 8, 9], onEnd: () => {}, now: () => 1_000_000, clock: () => Date.now(), transport: "ws",
  });
}

describe("readLayout", () => {
  it("carries the interiors the bake laid, with each room's origin and parts", () => {
    const { file, interiors } = laidDungeon();
    const layout = readLayout(file);
    assert.equal(layout.interiors?.length, interiors.length);
    layout.interiors?.forEach((room, i) => {
      assert.equal(room.room, interiors[i].room);
      assert.deepEqual(room.origin, interiors[i].origin);
      assert.equal(room.placements.length, interiors[i].placements.length);
      assert.equal(room.placements[0].assetRef, interiors[i].placements[0].assetRef);
    });
  });

  it("has no interiors when the bake laid none", () => {
    assert.deepEqual(readLayout(bake(1, false).file).interiors ?? [], []);
  });
});

describe("interiorSpawns", () => {
  it("places each part at its room's origin plus its offset, carrying its model's hash", () => {
    const { file, interiors } = laidDungeon();
    const expected = interiors.flatMap((room) =>
      room.placements.map((p) => ({
        x: room.origin[0] + p.transform.pos[0],
        y: p.transform.pos[1],
        z: room.origin[1] + p.transform.pos[2],
        rot: p.transform.rot,
        scale: p.transform.scale,
        assetHash: fnv1a32(p.assetRef),
      })),
    );
    assert.deepEqual(interiorSpawns(readLayout(file)), expected);
  });

  it("keeps every part inside the layout's bounds", () => {
    const layout = readLayout(laidDungeon().file);
    for (const s of interiorSpawns(layout)) {
      assert.ok(s.x >= -TOL && s.x <= layout.width * CELL_M + TOL, `x ${s.x} is outside the layout`);
      assert.ok(s.z >= -TOL && s.z <= layout.height * CELL_M + TOL, `z ${s.z} is outside the layout`);
    }
  });

  it("spawns nothing when no interior was laid", () => {
    assert.deepEqual(interiorSpawns(readLayout(bake(1, false).file)), []);
  });
});

/** Does entity `e` carry the part: its model, and its place, turn and scale to the store's precision. */
function carries(e: number, s: InteriorSpawn): boolean {
  const stored = [C.Transform.px[e], C.Transform.py[e], C.Transform.pz[e], C.Transform.qx[e], C.Transform.qy[e], C.Transform.qz[e], C.Transform.qw[e], C.Transform.sx[e], C.Transform.sy[e], C.Transform.sz[e]];
  const spawned = [s.x, s.y, s.z, ...s.rot, ...s.scale];
  return C.AssetRef.assetHash[e] === s.assetHash && stored.every((v, i) => Math.abs(v - spawned[i]) < STORE_TOL);
}

describe("interior parts in a run", () => {
  it("spawns one entity per part, carrying the part's model and transform", async () => {
    const layout = readLayout(laidDungeon().file);
    const spawns = interiorSpawns(layout);
    assert.ok(spawns.length > 0, "the baked dungeon lays parts to spawn");
    const laid = await instanceOf(layout);
    const bare = await instanceOf({ ...layout, interiors: [] });
    const count = (inst: DungeonInstance): number => [...defineQuery([C.Transform])(inst.world.ecs)].length;
    assert.equal(count(laid) - count(bare), spawns.length, "one entity per interior part");
    const parts = [...defineQuery([C.Transform, C.AssetRef])(laid.world.ecs)];
    for (const s of spawns) {
      assert.ok(parts.some((e) => carries(e, s)), `no entity carries the part at (${s.x}, ${s.y}, ${s.z}) with model ${s.assetHash}`);
    }
  });
});
