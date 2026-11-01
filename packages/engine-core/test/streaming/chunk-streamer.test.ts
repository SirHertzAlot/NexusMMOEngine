/**
 * ChunkStreamer: chunks load around players (nearest first, within a
 * budget and the world bounds), unload when players leave, and come back
 * from their stored rows — populated once, never duplicated, changes kept,
 * across restarts too.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addComponent, defineQuery, hasComponent, Not } from "bitecs";
import {
  ChunkEntityStore,
  ChunkStreamer,
  despawnSessionlessAvatars,
  Health,
  packChunk,
  PlayerIntent,
  SimWorld,
  SnapshotStore,
  Transform,
  unpackChunk,
  WorldItem,
  type ChunkDataSource,
  type ChunkPopulator,
  type ChunkStreamerOptions,
} from "../../src/index.js";

const SIZE = 16;
const flat: ChunkDataSource = { chunkSamples: 256, generateChunk: (_s, _cx, _cz, _l, out) => out.fill(0) };
const props = defineQuery([Transform, Not(PlayerIntent)]);

const tmpDb = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mmo-stream-")), "world.db");

/** Two props per chunk (a tree and a rock), at fixed spots inside it. */
function twoProps(): ChunkPopulator & { calls: number } {
  return {
    calls: 0,
    populate(world, cx, cz) {
      this.calls++;
      for (const [ox, oz] of [[3, 4], [11, 9]]) {
        const e = world.spawn();
        addComponent(world.ecs, Transform, e);
        Transform.px[e] = cx * SIZE + ox;
        Transform.pz[e] = cz * SIZE + oz;
        Transform.qw[e] = 1;
        addComponent(world.ecs, Health, e);
        Health.current[e] = 100;
        Health.max[e] = 100;
      }
    },
  };
}

function player(world: SimWorld, x: number, z: number): number {
  const e = world.spawn();
  addComponent(world.ecs, Transform, e);
  addComponent(world.ecs, PlayerIntent, e);
  Transform.px[e] = x;
  Transform.pz[e] = z;
  return e;
}

function streamer(store: ChunkEntityStore, extra: Partial<ChunkStreamerOptions> = {}): ChunkStreamer {
  return new ChunkStreamer({
    terrain: flat,
    worldSeed: 1n,
    chunkWorldSize: SIZE,
    store,
    loadBudgetMs: 1000,
    planEveryTicks: 1,
    unloadDelayTicks: 2,
    ...extra,
  });
}

/** Props standing in chunk (cx, cz). */
function propsIn(world: SimWorld, cx: number, cz: number): number[] {
  return Array.from(props(world.ecs)).filter(
    (e) => Math.floor(Transform.px[e] / SIZE) === cx && Math.floor(Transform.pz[e] / SIZE) === cz,
  );
}

const run = (s: ChunkStreamer, world: SimWorld, ticks: number): void => {
  for (let i = 0; i < ticks; i++) {
    s.step(world);
    world.endTick();
  }
};

describe("chunk keys", () => {
  test("pack/unpack round-trips, negative coords included", () => {
    for (const [cx, cz] of [[0, 0], [-1, 0], [0, -1], [-125, 124], [2 ** 24, -(2 ** 24)]]) {
      assert.deepEqual(unpackChunk(packChunk(cx, cz)), [cx, cz]);
    }
    assert.notEqual(packChunk(1, 0), packChunk(0, 1));
  });
});

describe("ChunkStreamer", () => {
  test("loads the area around a player, nearest first, inside the bounds", () => {
    const world = new SimWorld();
    const store = new ChunkEntityStore(tmpDb());
    const pop = twoProps();
    const s = streamer(store, {
      populator: pop,
      loadRadius: 2,
      maxLoadsPerTick: 5,
      bounds: { minCx: -1, minCz: -1, maxCx: 3, maxCz: 3 },
    });
    player(world, 8, 8); // chunk (0, 0)
    run(s, world, 1);
    assert.equal(s.stats.loaded, 5, "per-tick cap");
    assert.ok(s.isLoaded(0, 0), "the player's own chunk first");
    run(s, world, 10);
    // 5x5 around (0,0) clipped to x,z >= -1: 4x4 chunks.
    assert.equal(s.stats.loaded, 16);
    assert.ok(!s.isLoaded(-2, 0), "outside the bounds");
    assert.equal(pop.calls, 16);
    assert.equal(props(world.ecs).length, 32);
    store.close();
  });

  test("unloads when the player leaves, restores changes on return, never re-populates", () => {
    const world = new SimWorld();
    const store = new ChunkEntityStore(tmpDb());
    const pop = twoProps();
    const s = streamer(store, { populator: pop, loadRadius: 1, unloadRadius: 1 });
    const me = player(world, 8, 8);
    run(s, world, 1);
    assert.equal(s.stats.loaded, 9);
    // Damage the tree in chunk (1, 1); fell the rock in chunk (-1, 0).
    const [tree] = propsIn(world, 1, 1);
    Health.current[tree] = 5;
    const [, rock] = propsIn(world, -1, 0);
    world.despawn(rock);

    Transform.px[me] = 20 * SIZE; // far away
    run(s, world, 4);
    assert.equal(s.stats.unloads, 9, "the old area unloaded");
    assert.equal(store.count(), 9, "every unloaded chunk has a row");
    assert.equal(propsIn(world, 1, 1).length, 0, "its entities left the world");
    assert.equal(props(world.ecs).length, 18, "only the new area's props are live");

    Transform.px[me] = 8; // back home
    run(s, world, 4);
    assert.equal(pop.calls, 18, "the old area came back from rows, not scatter");
    assert.equal(s.stats.restored, 9);
    const home = propsIn(world, 1, 1);
    assert.equal(home.length, 2, "no duplicates");
    assert.deepEqual(home.map((e) => Health.current[e]).sort((a, b) => a - b), [5, 100], "damage kept");
    assert.equal(propsIn(world, -1, 0).length, 1, "the felled rock stays gone");
    store.close();
  });

  test("ground items (WorldItem) are not unloaded with their chunk", () => {
    const world = new SimWorld();
    const store = new ChunkEntityStore(tmpDb());
    const s = streamer(store, { loadRadius: 1, unloadRadius: 1 });
    const me = player(world, 8, 8);
    run(s, world, 1);
    const item = world.spawn();
    addComponent(world.ecs, Transform, item);
    Transform.px[item] = 20;
    Transform.pz[item] = 20;
    addComponent(world.ecs, WorldItem, item);
    WorldItem.item[item] = 7;
    Transform.px[me] = 20 * SIZE; // far away: the item's chunk unloads
    run(s, world, 4);
    assert.ok(s.stats.unloads > 0);
    assert.equal(hasComponent(world.ecs, WorldItem, item), true, "the item stays live (it expires on its own)");
    assert.equal(WorldItem.item[item], 7);
    store.close();
  });

  test("a chunk emptied of everything stays empty", () => {
    const world = new SimWorld();
    const store = new ChunkEntityStore(tmpDb());
    const pop = twoProps();
    const s = streamer(store, { populator: pop, loadRadius: 0, unloadRadius: 0 });
    const me = player(world, 8, 8);
    run(s, world, 1);
    for (const e of propsIn(world, 0, 0)) world.despawn(e);
    Transform.px[me] = 10 * SIZE;
    run(s, world, 4);
    Transform.px[me] = 8;
    run(s, world, 4);
    assert.ok(s.isLoaded(0, 0));
    assert.equal(propsIn(world, 0, 0).length, 0);
    assert.equal(pop.calls, 2, "(0,0) once, (10,0) once");
    store.close();
  });

  test("pinned chunks load at warm() and stay without players", () => {
    const world = new SimWorld();
    const store = new ChunkEntityStore(tmpDb());
    const s = streamer(store, { populator: twoProps(), pinned: [[0, 0], [1, 0], [99, 99]], bounds: { minCx: -5, minCz: -5, maxCx: 5, maxCz: 5 } });
    assert.equal(s.warm(world), 2, "the out-of-bounds pin is ignored");
    run(s, world, 10);
    assert.deepEqual(s.loadedChunks().sort(), [[0, 0], [1, 0]]);
    assert.equal(s.stats.unloads, 0);
    store.close();
  });

  test("after a restart, restored chunks are adopted (rows ignored, nothing doubled)", () => {
    const dbPath = tmpDb();
    const snapshots = new SnapshotStore({ dbPath });
    const store = new ChunkEntityStore(dbPath);
    SimWorld.resetEntityCursorForTesting();
    const before = new SimWorld();
    const pop = twoProps();
    const s1 = streamer(store, { populator: pop, loadRadius: 1, unloadRadius: 1 });
    const me = player(before, 8, 8);
    run(s1, before, 1);
    // Leave and come back, so the home area has (now stale) rows too.
    Transform.px[me] = 20 * SIZE;
    run(s1, before, 4);
    Transform.px[me] = 8;
    run(s1, before, 4);
    const tree = propsIn(before, 0, 0)[0];
    Health.current[tree] = 42; // newer than the row
    snapshots.saveWorld(100, before);

    SimWorld.resetEntityCursorForTesting();
    const after = new SimWorld();
    assert.equal(snapshots.restoreInto(after), 100);
    despawnSessionlessAvatars(after);
    const s2 = streamer(store, { populator: pop, loadRadius: 1, unloadRadius: 1 });
    assert.equal(s2.adopt(after), 9, "the home area (the far one had unloaded before the save)");
    assert.equal(propsIn(after, 0, 0).length, 2, "not doubled");
    assert.ok(propsIn(after, 0, 0).some((e) => Health.current[e] === 42), "the snapshot, not the stale row");

    // No players: everything unloads, and the rows now carry the latest state.
    const calls = pop.calls;
    run(s2, after, 4);
    assert.equal(s2.stats.loaded, 0);
    assert.equal(props(after.ecs).length, 0);
    const back = player(after, 8, 8);
    void back;
    run(s2, after, 1);
    assert.equal(pop.calls, calls, "restored from rows");
    assert.ok(propsIn(after, 0, 0).some((e) => Health.current[e] === 42));
    assert.equal(propsIn(after, 0, 0).length, 2);
    snapshots.close();
    store.close();
  });

  test("terrain colliders follow chunks: added on load and adopt, removed on unload", () => {
    const world = new SimWorld();
    const store = new ChunkEntityStore(tmpDb());
    const live = new Map<string, Float32Array>();
    const colliders = {
      add: (cx: number, cz: number, heights: Float32Array) => {
        assert.ok(!live.has(`${cx},${cz}`), "never added twice");
        live.set(`${cx},${cz}`, heights);
        return true;
      },
      remove: (cx: number, cz: number) => {
        assert.ok(live.delete(`${cx},${cz}`), "only loaded chunks are removed");
      },
    };
    const s = streamer(store, { loadRadius: 1, unloadRadius: 1, colliders });
    const me = player(world, 8, 8);
    run(s, world, 1);
    assert.equal(live.size, 9);
    assert.equal(live.get("0,0")?.length, 256, "with the chunk's heights");
    Transform.px[me] = 20 * SIZE;
    run(s, world, 4);
    assert.deepEqual([...live.keys()].sort(), s.loadedChunks().map(([cx, cz]) => `${cx},${cz}`).sort());

    // A restart: adopted chunks get their colliders too.
    live.clear();
    const s2 = streamer(store, { loadRadius: 1, unloadRadius: 1, colliders });
    assert.equal(s2.adopt(world), 9);
    assert.equal(live.size, 9);
    store.close();
  });

  test("holds a chunk back while its ground has no room, then loads it", () => {
    const world = new SimWorld();
    const store = new ChunkEntityStore(tmpDb());
    const warnings: string[] = [];
    const live = new Set<string>();
    let room = false;
    const colliders = {
      add: (cx: number, cz: number) => {
        if (!room) return false;
        live.add(`${cx},${cz}`);
        return true;
      },
      remove: (cx: number, cz: number) => {
        live.delete(`${cx},${cz}`);
      },
    };
    const s = streamer(store, { loadRadius: 1, unloadRadius: 1, colliders, warn: (m) => warnings.push(m) });
    player(world, 8, 8);
    run(s, world, 3);
    assert.equal(s.stats.loaded, 0, "no chunk loads without its ground");
    assert.equal(world.liveEntityCount, 1, "and none is left behind: only the player");
    assert.equal(warnings.length, 1, "says so once");
    assert.match(warnings[0], /no room for chunk/);
    room = true;
    run(s, world, 3);
    assert.equal(s.stats.loaded, 9);
    assert.equal(live.size, 9);
    store.close();
  });

  test("warm holds a pinned chunk back while its ground has no room, and the planner loads it later", () => {
    const world = new SimWorld();
    const store = new ChunkEntityStore(tmpDb());
    const warnings: string[] = [];
    let room = false;
    const colliders = { add: () => room, remove: () => {} };
    const s = streamer(store, { loadRadius: 1, unloadRadius: 1, colliders, pinned: [[0, 0]], warn: (m) => warnings.push(m) });
    player(world, 8, 8);
    assert.equal(s.warm(world), 0, "nothing warmed without room");
    assert.equal(s.stats.loaded, 0);
    assert.equal(warnings.length, 1, "says so once");
    room = true;
    run(s, world, 3);
    assert.ok(s.loadedChunks().some(([cx, cz]) => cx === 0 && cz === 0), "the pinned chunk loads once there is room");
    store.close();
  });

  test("stops loading at the entity budget, and says so once", () => {
    const world = new SimWorld();
    const store = new ChunkEntityStore(tmpDb());
    const warnings: string[] = [];
    // 1 player + 1 chunk entity + 2 props per chunk: 7 entities after two chunks.
    const s = streamer(store, { populator: twoProps(), loadRadius: 2, entityBudget: 7, warn: (m) => warnings.push(m) });
    player(world, 8, 8);
    run(s, world, 5);
    assert.equal(s.stats.loaded, 2);
    assert.equal(world.liveEntityCount, 7);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /budget 7/);
    store.close();
  });

  test("rejects an unload radius inside the load radius", () => {
    const store = new ChunkEntityStore(tmpDb());
    assert.throws(() => streamer(store, { loadRadius: 4, unloadRadius: 3 }), /unloadRadius/);
    store.close();
  });
});
