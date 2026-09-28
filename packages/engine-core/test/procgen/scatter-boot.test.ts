/**
 * Scatter chunk-load integration (PCG slice 4): the exact sequence the
 * region server runs at boot.
 *
 * 1. Fresh boot: spawnChunk -> scatterChunkToECS. Entities appear with
 *    Transform + AssetRef (+ Health/BodyConfig per archetype).
 * 2. Snapshot to SQLite, restore into a fresh world (reboot).
 * 3. The restore path skips scatter (freshBoot == false in server.ts),
 *    so entity count and AssetRef rows are identical — no duplicates.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hasComponent } from "bitecs";
import {
  AssetRef,
  SimWorld,
  SnapshotStore,
  Transform,
  collectFullState,
  loadScatterContent,
  makeProcgenChunkSource,
  makeScatterBinding,
  scatterChunkToECS,
  spawnChunk,
} from "../../src/index.js";

const WORLD_SEED = 1234n;

/** Mirrors server.ts main(): chunk spawn + scatter only on fresh boot. */
function bootChunk(sim: SimWorld, freshBoot: boolean): number[] {
  if (!freshBoot) return []; // restore path: chunk + entities come from the snapshot
  const procgen = makeProcgenChunkSource();
  const { heights } = spawnChunk(sim, procgen, WORLD_SEED, 0, 0, 0);
  return scatterChunkToECS(sim, makeScatterBinding(), loadScatterContent(), {
    worldSeed: WORLD_SEED,
    cx: 0,
    cz: 0,
    heights,
    chunkWorldSize: 16,
  });
}

test("chunk-load scatter: fresh boot spawns environment, reboot restores without duplication", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scatter-reboot-"));

  // --- fresh boot -------------------------------------------------------
  const sim = new SimWorld();
  const scattered = bootChunk(sim, true);
  assert.ok(scattered.length > 0, "scatter spawns entities on chunk (0,0)");
  for (const eid of scattered) {
    assert.ok(hasComponent(sim.ecs, Transform, eid));
    assert.ok(hasComponent(sim.ecs, AssetRef, eid));
    assert.ok(AssetRef.assetHash[eid] !== 0, "asset hash populated");
  }
  const before = collectFullState(sim, 1);
  const assetRows = new Map(
    before.assets.map((r) => [r.wireId, [r.assetHash, r.variant] as const]),
  );
  assert.equal(assetRows.size, scattered.length);

  // --- save + reboot ----------------------------------------------------
  const store = new SnapshotStore({
    dbPath: path.join(dir, "world.db"),
    saveEveryTicks: 1,
  });
  store.saveWorld(1, sim);
  store.close();

  SimWorld.resetEntityCursorForTesting();
  const rebooted = new SimWorld();
  const store2 = new SnapshotStore({ dbPath: path.join(dir, "world.db") });
  const restoredTick = store2.restoreInto(rebooted);
  store2.close();
  assert.equal(restoredTick, 1);
  const freshBoot = restoredTick == null;
  assert.equal(freshBoot, false);
  bootChunk(rebooted, freshBoot); // must be a no-op on restore

  // --- no duplicates: identical entity + AssetRef state -----------------
  const after = collectFullState(rebooted, 1);
  assert.equal(after.assets.length, before.assets.length);
  for (const r of after.assets) {
    assert.deepEqual(assetRows.get(r.wireId), [r.assetHash, r.variant]);
  }
  assert.equal(
    rebooted.liveEntityCount,
    sim.liveEntityCount,
    "reboot adds zero entities",
  );

  fs.rmSync(dir, { recursive: true, force: true });
});
