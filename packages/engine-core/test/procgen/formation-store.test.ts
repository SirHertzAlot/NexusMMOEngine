/**
 * Baked formation tiles: the bake solves every tile into world.db, and a
 * server over that store only reads them (solving nothing); tiles round-
 * trip exactly, a changed plan or terrain misses, and a missing tile is
 * solved on demand and written back.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEcologyPlan, type EcologyPlan } from "../../src/procgen/ecology.js";
import { bakeFormations, FormationCache, formationTile, type FormationEnv } from "../../src/procgen/formation.js";
import { decodeFormationPoints, encodeFormationPoints, FormationTileStore } from "../../src/persist/formation-tiles.js";

const W = 16;
function heights(cx: number, cz: number): Float32Array {
  const h = new Float32Array(256);
  for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) h[j * 16 + i] = 5 + Math.sin((cx * W + i) / 23) * 0.5 + Math.cos((cz * W + j) / 31) * 0.4;
  return h;
}

const plan: EcologyPlan = parseEcologyPlan({
  version: 1,
  name: "test",
  fields: {},
  biomes: {},
  layers: [
    {
      id: "circles",
      place: { kind: "formation", spacing: 7, tileChunks: 4 },
      chance: 1,
      formation: {
        kinds: [
          {
            id: "circle",
            weight: 1,
            tags: ["circle"],
            pieces: [{ id: "stone", assets: [{ asset: "rock", weight: 1 }], count: [5, 7], pattern: "ring", radius: [4, 5], clearance: 1.2 }],
          },
        ],
        emptyWeight: 4,
        avoid: [{ a: "circle", b: "circle", distance: 30 }],
      },
      assets: [],
      scale: [1, 1],
    },
  ],
});
const env: FormationEnv = { seed32: 11, chunkWorldSize: W, heightsOf: heights };
const key = { worldSeed: 1234n, terrainVersion: "7", planHash: "abc" };
const db = (): string => join(mkdtempSync(join(tmpdir(), "formations-")), "world.db");

describe("formation tile store", () => {
  it("round-trips points exactly", () => {
    const pts = [{ x: 1.25, y: 4.5, z: -3.5, i: -2, j: 7, option: 2 }, { x: 1e-9, y: -0.25, z: 1e6, i: 0, j: 0, option: -1 }];
    assert.deepEqual(decodeFormationPoints(encodeFormationPoints(pts)), pts);
    assert.throws(() => decodeFormationPoints(new Uint8Array(5)), /not a whole number of points/);
  });

  it("is filled by the bake, and then read without solving", () => {
    const file = db();
    const store = new FormationTileStore(file);
    const baking = new FormationCache(1024, store.backing(key));
    let covered = 0;
    store.transaction(() => (covered = bakeFormations(plan, env, baking, { x: -8, z: -8 }, { x: 7, z: 7 })));
    assert.equal(covered, 16, "4 x 4 tiles of 4 x 4 chunks");
    assert.ok(baking.solved >= 16);
    assert.equal(store.count(key), baking.solved);
    store.close();

    // A later run (the server) over the same store: every tile is a read.
    const reopened = new FormationTileStore(file);
    const serving = new FormationCache(1024, reopened.backing(key));
    const fresh = new FormationCache();
    for (let tj = -2; tj <= 1; tj++)
      for (let ti = -2; ti <= 1; ti++) {
        assert.deepEqual(formationTile(plan, plan.layers[0], env, serving, ti, tj), formationTile(plan, plan.layers[0], env, fresh, ti, tj));
      }
    assert.equal(serving.solved, 0, "nothing solved on the server");
    reopened.close();
  });

  it("misses for another plan or terrain, and stores tiles solved on demand", () => {
    const store = new FormationTileStore(db());
    const a = new FormationCache(1024, store.backing(key));
    formationTile(plan, plan.layers[0], env, a, 0, 0);
    const other = new FormationCache(1024, store.backing({ ...key, planHash: "changed" }));
    formationTile(plan, plan.layers[0], env, other, 0, 0);
    assert.ok(other.solved > 0, "a changed plan solves again");
    assert.ok(store.count({ ...key, planHash: "changed" }) > 0, "and stores it");
    const b = new FormationCache(1024, store.backing(key));
    formationTile(plan, plan.layers[0], env, b, 0, 0);
    assert.equal(b.solved, 0, "the original key reads what was stored");
    store.close();
  });
});
