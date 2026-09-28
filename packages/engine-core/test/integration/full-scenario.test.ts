/**
 * Phase 3 integration slice: ONE headless end-to-end scenario proving the
 * whole engine works as a unit.
 *
 * Scenario "cross the valley":
 *  1. Boot the real server stack (gateway + real Jolt physics + real
 *     Recast/Detour navigation + real CSV auth + real SnapshotStore +
 *     real navmesh tile registry), all state in a fresh temp dir.
 *  2. Generate a REAL procgen chunk (FastNoise2 addon) and bake its
 *     navmesh tile at chunk-load time; the tile goes into the
 *     content-addressed registry (never into world snapshots).
 *  3. A client registers/logs in over the real auth flow, connects, and
 *     receives the welcome snapshot.
 *  4. The player entity becomes a dynamic sphere dropped from height: it
 *     falls, comes to rest on a static pad, and never tunnels.
 *  5. A walker NPC (kinematic body) gets a PathRequest across the chunk;
 *     the real navmesh returns waypoints and a test-local steering system
 *     walks it to the destination. (Steering is intentionally JS-side per
 *     the navigation slice; FollowPathSystem is test-only scaffolding
 *     that exercises the WaypointStore contract, not engine code.)
 *  6. Deltas flow every tick; folding them into the welcome snapshot
 *     reproduces the server's entity transforms (client mirror check).
 *  7. Mid-run the world is saved, the server is shut down ("killed": the
 *     gateway closes and both native worlds are destroyed), then rebooted
 *     from the snapshot resuming at tick+1 with fresh native backends and
 *     tiles reloaded from the registry. The walker re-issues its path
 *     request and finishes the walk; the resting sphere is undisturbed.
 *  8. Before the kill, the client disconnects and reconnects with the same
 *     session token inside the grace period: the SAME player entity
 *     re-attaches (no duplicate).
 *
 * The scenario runs twice in one process (fresh temp dirs each run) to
 * prove no cross-run state leaks.
 *
 * Cleanup discipline: every acquired resource lives in a guarded `let`
 * and is released in the trailing `finally`. A failed assertion must not
 * leak an open gateway/socket/native world — leaked handles keep the
 * event loop alive and hang the whole suite on exit.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addComponent, defineQuery } from "bitecs";
import { MessageType } from "@mmo-engine/protocol";
import {
  Gateway,
  SimWorld,
  parseWireEntityId,
  Transform,
  Velocity,
  BodyConfig,
  ShapeKind,
  MotionType,
  PathRequest,
  PathState,
  PathRequestStatus,
  IntentSystem,
  IntegrateSystem,
  PhysicsSystem,
  createJoltBackend,
  NavigationSystem,
  createNavigationBackend,
  bakeChunkTile,
  DEFAULT_BAKE_CONFIG,
  makeProcgenChunkSource,
  SnapshotStore,
  NavmeshTileRegistry,
  decodeSnapshot,
  decodeDelta,
  stateFromCollected,
  applyDelta,
  type SimSystem,
  type PhysicsBackend,
  type NavmeshTileKey,
  type ChunkDataSource,
} from "../../src/index.js";
import type { NavigationBackend } from "../../src/navigation/backend.js";
import { HeadlessClient } from "../net/headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "../net/auth-harness.js";

const STEP_MS = 1000 / 30;
const SEED = 1234n;
const CHUNK_WORLD_SIZE = 16;
const WALK_SPEED = 3; // units/second for the test steering shim

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Test-local steering: walks entities with an Active PathState toward
 * their waypoints. NOT engine code — it exercises the WaypointStore
 * contract (offset/count + dense arena) the way a future JS steering
 * system will. Progress (current waypoint index) is tracked here because
 * PathState carries no cursor by design.
 */
class FollowPathSystem implements SimSystem {
  readonly name = "test:follow-path";
  private readonly cursor = new Map<number, number>();
  private readonly query = defineQuery([Transform, PathState]);

  constructor(
    private readonly navigation: NavigationSystem,
    private readonly speed: number = WALK_SPEED,
  ) {}

  step(sim: SimWorld, dtSeconds: number): void {
    for (const eid of this.query(sim.ecs)) {
      if (PathState.status[eid] !== PathRequestStatus.Active) {
        this.cursor.delete(eid);
        continue;
      }
      const count = PathState.waypointCount[eid];
      if (count === 0) continue;
      const data = this.navigation.waypoints.data;
      const off = PathState.waypointOffset[eid];
      let i = this.cursor.get(eid) ?? 0;
      // Skip waypoints already reached (the first is usually the start).
      while (i < count) {
        const dx = data[off + i * 3] - Transform.px[eid];
        const dz = data[off + i * 3 + 2] - Transform.pz[eid];
        if (dx * dx + dz * dz < 0.16) i++;
        else break;
      }
      this.cursor.set(eid, i);
      if (i >= count) continue;
      const wx = data[off + i * 3];
      const wy = data[off + i * 3 + 1];
      const wz = data[off + i * 3 + 2];
      const dx = wx - Transform.px[eid];
      const dz = wz - Transform.pz[eid];
      const dist = Math.hypot(dx, dz);
      const stepLen = Math.min(this.speed * dtSeconds, dist);
      if (dist > 1e-6) {
        Transform.px[eid] += (dx / dist) * stepLen;
        Transform.pz[eid] += (dz / dist) * stepLen;
      }
      Transform.py[eid] = wy + 0.5; // ride at body-center height
    }
  }
}

function navBackendConfig() {
  return {
    originX: 0,
    originZ: 0,
    tileWorldSize: CHUNK_WORLD_SIZE,
    profiles: [{ id: 0, agentHeight: 2, agentRadius: 0.6, agentMaxClimb: 0.9 }],
  };
}

/**
 * bitECS component stores are process-global: they survive SimWorld
 * replacement within one process. A real reboot (fresh process) starts
 * with zeroed stores. PathRequest/PathState are transient and deliberately
 * NOT snapshotted, so this in-process reboot — and the second scenario run
 * — must reset them to the zero state explicitly. Otherwise a stale token
 * makes NavigationSystem skip a re-issued request (token unchanged) and a
 * stale waypointOffset points into the new backend's empty WaypointStore.
 */
function zeroTransientPathStores(): void {
  const stores = [
    PathRequest.x,
    PathRequest.z,
    PathRequest.profile,
    PathRequest.token,
    PathState.status,
    PathState.token,
    PathState.waypointOffset,
    PathState.waypointCount,
  ] as unknown as Array<{ fill(v: number): void }>;
  for (const s of stores) s.fill(0);
}

/** Nearest heightmap sample for world (x, z) on chunk (0,0). */
function makeHeightSampler(source: ChunkDataSource, seed: bigint) {
  const heights = new Float32Array(source.chunkSamples);
  source.generateChunk(seed, 0, 0, 0, heights);
  return (x: number, z: number): number => {
    const i = Math.max(0, Math.min(15, Math.round((x / CHUNK_WORLD_SIZE) * 15)));
    const j = Math.max(0, Math.min(15, Math.round((z / CHUNK_WORLD_SIZE) * 15)));
    return heights[j * 16 + i];
  };
}

function addBody(
  sim: SimWorld,
  eid: number,
  opts: {
    shapeKind: number;
    halfX?: number;
    halfY?: number;
    halfZ?: number;
    radius?: number;
    mass: number;
    motionType: number;
    layer: number;
    friction?: number;
    restitution?: number;
  },
): void {
  addComponent(sim.ecs, BodyConfig, eid);
  BodyConfig.shapeKind[eid] = opts.shapeKind;
  BodyConfig.halfX[eid] = opts.halfX ?? 0;
  BodyConfig.halfY[eid] = opts.halfY ?? 0;
  BodyConfig.halfZ[eid] = opts.halfZ ?? 0;
  BodyConfig.radius[eid] = opts.radius ?? 0;
  BodyConfig.mass[eid] = opts.mass;
  BodyConfig.motionType[eid] = opts.motionType;
  BodyConfig.layer[eid] = opts.layer;
  BodyConfig.friction[eid] = opts.friction ?? 0.5;
  BodyConfig.restitution[eid] = opts.restitution ?? 0;
}

function place(sim: SimWorld, eid: number, x: number, y: number, z: number): void {
  Transform.px[eid] = x;
  Transform.py[eid] = y;
  Transform.pz[eid] = z;
  Transform.qx[eid] = 0;
  Transform.qy[eid] = 0;
  Transform.qz[eid] = 0;
  Transform.qw[eid] = 1;
  Transform.sx[eid] = 1;
  Transform.sy[eid] = 1;
  Transform.sz[eid] = 1;
}

/**
 * One full run of the scenario. All server state lives under a fresh temp
 * dir; native backends are created and destroyed inside the run.
 */
async function runScenario(label: string): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-scenario-"));
  const dbPath = path.join(dir, "world.db");
  const navmeshDir = path.join(dir, "navmesh");
  const credentialStore = await makeCredentialStore();
  const procgen = makeProcgenChunkSource();
  const heightAt = makeHeightSampler(procgen, SEED);

  let now = 1_000_000;
  let gw: Gateway | null = null;
  let physics: PhysicsSystem | null = null;
  let navBackend: NavigationBackend | null = null;
  let registry: NavmeshTileRegistry | null = null;
  let store: SnapshotStore | null = null;
  let client: HeadlessClient | null = null;
  let client2: HeadlessClient | null = null;
  let client3: HeadlessClient | null = null;
  let physics2: PhysicsSystem | null = null;
  let navBackend2: NavigationBackend | null = null;
  let registry2: NavmeshTileRegistry | null = null;
  let store2: SnapshotStore | null = null;
  let tileRefs: ReturnType<NavigationBackend["loadTiles"]> | null = null;
  let tileRefs2: ReturnType<NavigationBackend["loadTiles"]> | null = null;

  try {
    // Fresh-process model: transient (non-snapshotted) component stores
    // start zeroed (see zeroTransientPathStores).
    zeroTransientPathStores();

    // ---- boot the real server stack -----------------------------------
    const jolt: PhysicsBackend = createJoltBackend();
    physics = new PhysicsSystem(jolt);
    navBackend = createNavigationBackend(navBackendConfig());
    const navigation = new NavigationSystem({ backend: navBackend });
    const follow = new FollowPathSystem(navigation);

    // Procgen chunk -> navmesh tile, baked at chunk-load time (never per tick).
    const bakeStart = Date.now();
    const baked = bakeChunkTile(
      {
        backend: navBackend,
        source: procgen,
        seed: SEED,
        chunkWorldSize: CHUNK_WORLD_SIZE,
        bakeConfig: { ...DEFAULT_BAKE_CONFIG },
      },
      0,
      0,
    );
    const bakeMs = Date.now() - bakeStart;
    assert.ok(baked.stats.polyCount > 0, `[${label}] baked tile has polys`);
    assert.ok(baked.blob.length > 0, `[${label}] baked tile has a blob`);
    const tileKey: NavmeshTileKey = {
      worldSeed: SEED.toString(),
      chunkX: 0,
      chunkZ: 0,
      terrainVersion: 1,
      agentProfile: 0,
      bakeConfigHash: baked.bakeConfigHash,
    };
    registry = new NavmeshTileRegistry({ dir: navmeshDir });
    registry.register(tileKey, baked.blob);
    tileRefs = navBackend.loadTiles([baked.blob]);

    gw = new Gateway({
      clock: () => now,
      disconnectGraceMs: 1000,
      credentialStore,
      systems: [
        new IntentSystem(),
        new IntegrateSystem(),
        navigation,
        follow,
        physics,
      ],
    });
    const port = await gw.listen();
    gw.frame(now); // prime the loop clock (see gateway.test.ts)
    const url = `ws://127.0.0.1:${port}`;
    const frames = (n: number): void => {
      for (let i = 0; i < n; i++) {
        now += STEP_MS;
        gw!.frame(now);
      }
    };

    // ---- client joins over the real auth flow ---------------------------
    client = new HeadlessClient();
    await client.connect(url);
    const snapP = client.waitFor(MessageType.Snapshot, 1);
    const welcome = await client.hello("alice", {
      username: "alice",
      password: TEST_PASSWORD,
    });
    const [snapPayload] = await snapP;
    const welcomeState = decodeSnapshot(snapPayload);
    const playerWid = BigInt(welcome.player_entity);
    const playerEid = parseWireEntityId(playerWid).slot;
    assert.match(welcome.session_token, /^[0-9a-f]{64}$/, "session token issued");

    // ---- the player becomes a dynamic sphere, dropped from height -------
    // Kept clear of the walker's diagonal path (x == z) so the kinematic
    // walker can never shove the resting sphere.
    const DROP = { x: 13, z: 3 };
    const padTopY = heightAt(DROP.x, DROP.z);
    place(gw.world, playerEid, DROP.x, 10, DROP.z);
    addBody(gw.world, playerEid, {
      shapeKind: ShapeKind.Sphere,
      radius: 0.5,
      mass: 1,
      motionType: MotionType.Dynamic,
      layer: 1,
    });

    // Static landing pad, top flush with the local procgen terrain height.
    const pad = gw.world.spawn();
    addComponent(gw.world.ecs, Transform, pad);
    addComponent(gw.world.ecs, Velocity, pad);
    place(gw.world, pad, DROP.x, padTopY - 0.5, DROP.z);
    addBody(gw.world, pad, {
      shapeKind: ShapeKind.Box,
      halfX: 2,
      halfY: 0.5,
      halfZ: 2,
      mass: 0,
      motionType: MotionType.Static,
      layer: 0,
      friction: 0.8,
    });
    const padWid = gw.world.wireId(pad);

    // ---- walker NPC: kinematic body + path request across the chunk -----
    const START = { x: 2, z: 2 };
    const DEST = { x: 14, z: 14 };
    const walker = gw.world.spawn();
    addComponent(gw.world.ecs, Transform, walker);
    addComponent(gw.world.ecs, Velocity, walker);
    addComponent(gw.world.ecs, PathRequest, walker);
    addComponent(gw.world.ecs, PathState, walker);
    place(gw.world, walker, START.x, heightAt(START.x, START.z) + 0.5, START.z);
    addBody(gw.world, walker, {
      shapeKind: ShapeKind.Sphere,
      radius: 0.5,
      mass: 1,
      motionType: MotionType.Kinematic,
      layer: 1,
    });
    PathRequest.x[walker] = DEST.x;
    PathRequest.z[walker] = DEST.z;
    PathRequest.profile[walker] = 0;
    PathRequest.token[walker] = 1;
    const walkerWid = gw.world.wireId(walker);

    // ---- phase 1: 90 ticks ------------------------------------------------
    // One delta per tick is asserted via the waiter armed before frames().
    const deltasP = client.waitFor(MessageType.Delta, 90, 60000);
    let minSphereY = Infinity;
    for (let i = 0; i < 90; i++) {
      now += STEP_MS;
      gw.frame(now);
      if (Transform.py[playerEid] < minSphereY) minSphereY = Transform.py[playerEid];
    }
    const deltas = await deltasP;
    assert.equal(deltas.length, 90, `[${label}] one delta per tick`);
    for (const d of deltas) decodeDelta(d); // every delta must parse

    // Physics: the sphere fell, rests on the pad, never tunneled through it.
    const restY = padTopY + 0.5;
    assert.ok(
      minSphereY > restY - 0.3,
      `[${label}] no tunneling: min y ${minSphereY} vs rest ${restY}`,
    );
    assert.ok(
      Math.abs(Transform.py[playerEid] - restY) < 0.1,
      `[${label}] sphere rests on pad: y=${Transform.py[playerEid]} vs ${restY}`,
    );
    assert.ok(
      Math.abs(Velocity.ly[playerEid]) < 0.05,
      `[${label}] sphere velocity settled: vy=${Velocity.ly[playerEid]}`,
    );

    // Navigation: the real navmesh resolved the request into waypoints.
    assert.equal(
      PathState.status[walker],
      PathRequestStatus.Active,
      `[${label}] path resolved to Active`,
    );
    assert.ok(
      PathState.waypointCount[walker] >= 2,
      `[${label}] path has waypoints`,
    );

    // Client mirror check: folding the 90 deltas into the welcome snapshot
    // reproduces the server's transforms.
    const folded = stateFromCollected(welcomeState);
    for (const d of deltas) applyDelta(folded, decodeDelta(d));
    for (const [wid, eid, name] of [
      [playerWid, playerEid, "player"],
      [walkerWid, walker, "walker"],
      [padWid, pad, "pad"],
    ] as const) {
      const row = folded.get(wid)?.transform;
      assert.ok(row, `[${label}] ${name} present in folded client state`);
      const pairs: Array<[number, number, string]> = [
        [row.px, Transform.px[eid], "px"],
        [row.py, Transform.py[eid], "py"],
        [row.pz, Transform.pz[eid], "pz"],
      ];
      for (const [a, b, f] of pairs) {
        assert.ok(
          Math.abs(a - b) <= 1e-3,
          `[${label}] mirror ${name}.${f}: client ${a} vs server ${b}`,
        );
      }
    }

    // ---- reconnect: same token re-attaches the same player entity -------
    await client.close();
    client = null;
    await sleep(50); // let the server observe the close
    now += 500; // inside the 1000 ms grace period
    client2 = new HeadlessClient();
    await client2.connect(url);
    const snapP2 = client2.waitFor(MessageType.Snapshot, 1);
    const welcome2 = await client2.hello("alice", { token: welcome.session_token });
    const [snapPayload2] = await snapP2;
    assert.equal(
      BigInt(welcome2.player_entity),
      playerWid,
      `[${label}] same token re-attaches the same player entity`,
    );
    assert.ok(
      decodeSnapshot(snapPayload2).transforms.some((r) => r.wireId === playerWid),
      `[${label}] re-attached snapshot contains the player`,
    );

    // ---- save, "kill", reboot ---------------------------------------------
    const tickAtSave = gw.serverTick;
    store = new SnapshotStore({ dbPath });
    store.saveWorld(tickAtSave, gw.world);
    await client2.close();
    client2 = null;
    await gw.close();
    gw = null;
    physics.close();
    physics = null;
    navBackend.unloadTiles(tileRefs);
    navBackend.destroy();
    navBackend = null;
    tileRefs = null;
    registry.close();
    registry = null;
    store.close();
    store = null;

    // Fresh-process model: new native worlds, tile reloaded from the
    // registry (never re-baked), world restored, ticks resume at save+1.
    SimWorld.resetEntityCursorForTesting();
    const jolt2: PhysicsBackend = createJoltBackend();
    physics2 = new PhysicsSystem(jolt2);
    navBackend2 = createNavigationBackend(navBackendConfig());
    const navigation2 = new NavigationSystem({ backend: navBackend2 });
    const follow2 = new FollowPathSystem(navigation2);
    registry2 = new NavmeshTileRegistry({ dir: navmeshDir });
    const rec = registry2.lookup(tileKey);
    assert.ok(rec, `[${label}] tile record survives reboot in the registry`);
    const blob = registry2.loadBlob(rec);
    assert.ok(blob && blob.length > 0, `[${label}] tile blob loads from disk`);
    tileRefs2 = navBackend2.loadTiles([blob]);

    store2 = new SnapshotStore({ dbPath });
    const restored = new SimWorld();
    const restoredTick = store2.restoreInto(restored);
    store2.close();
    store2 = null;
    assert.equal(restoredTick, tickAtSave, `[${label}] restore lands on the saved tick`);

    gw = new Gateway({
      world: restored,
      startTick: restoredTick + 1,
      clock: () => now,
      disconnectGraceMs: 1000,
      credentialStore,
      systems: [
        new IntentSystem(),
        new IntegrateSystem(),
        navigation2,
        follow2,
        physics2,
      ],
    });
    const port2 = await gw.listen();
    gw.frame(now); // prime the loop clock
    const url2 = `ws://127.0.0.1:${port2}`;
    const frames2 = (n: number): void => {
      for (let i = 0; i < n; i++) {
        now += STEP_MS;
        gw!.frame(now);
      }
    };

    // PathRequest/PathState are intentionally not in snapshots (transient
    // intent); the walker re-issues its request after the reboot.
    // Reset transient path stores to the zero state a real fresh process
    // would have (see zeroTransientPathStores), then re-issue.
    zeroTransientPathStores();
    const walker2 = parseWireEntityId(walkerWid).slot;
    addComponent(restored.ecs, PathRequest, walker2);
    addComponent(restored.ecs, PathState, walker2);
    PathRequest.x[walker2] = DEST.x;
    PathRequest.z[walker2] = DEST.z;
    PathRequest.profile[walker2] = 0;
    PathRequest.token[walker2] = 1;

    // The old player entity rode through the restore (its session did not).
    const playerEid2 = parseWireEntityId(playerWid).slot;
    assert.ok(
      Math.abs(Transform.py[playerEid2] - restY) < 0.1,
      `[${label}] physics state survives restore: sphere still at rest`,
    );

    // Run a few ticks before the client joins: Gateway only sets its tick
    // inside onTick, so this advances server_tick past the restore point.
    frames2(3);

    // ---- phase 2: finish the walk -----------------------------------------
    client3 = new HeadlessClient();
    await client3.connect(url2);
    const snapP3 = client3.waitFor(MessageType.Snapshot, 1);
    const welcome3 = await client3.hello("alice", {
      username: "alice",
      password: TEST_PASSWORD,
    });
    await snapP3;
    assert.ok(
      welcome3.server_tick >= tickAtSave + 1,
      `[${label}] server resumes at saved tick + 1 (got ${welcome3.server_tick}, saved ${tickAtSave})`,
    );
    assert.notEqual(
      BigInt(welcome3.player_entity),
      playerWid,
      `[${label}] fresh login after reboot spawns a new player entity`,
    );

    // Fixed 10-tick batches: each batch must deliver exactly 10 deltas,
    // proving per-tick flow continues on top of the restored baseline.
    // Total ticks stay below 300 so no periodic full snapshot interferes.
    let ticks2 = 0;
    let arrived = false;
    const c3 = client3!;
    while (!arrived && ticks2 < 200) {
      const dP = c3.waitFor(MessageType.Delta, 10, 60000);
      frames2(10);
      ticks2 += 10;
      const got = await dP;
      assert.equal(got.length, 10, `[${label}] 10 deltas per 10 ticks after reboot`);
      const dx = Transform.px[walker2] - DEST.x;
      const dz = Transform.pz[walker2] - DEST.z;
      arrived = dx * dx + dz * dz < 1;
    }
    assert.ok(arrived, `[${label}] walker reaches the destination after reboot`);
    assert.ok(
      PathState.status[walker2] === PathRequestStatus.Active,
      `[${label}] re-issued path resolved after reboot`,
    );

    // ---- orderly shutdown (the finally below is the failure backstop) ----
    await client3.close();
    client3 = null;
    await gw.close();
    gw = null;
    physics2.close();
    physics2 = null;
    navBackend2.unloadTiles(tileRefs2);
    navBackend2.destroy();
    navBackend2 = null;
    tileRefs2 = null;
    registry2.close();
    registry2 = null;

    console.log(
      `[${label}] OK: bake ${bakeMs}ms, 90+${ticks2} ticks, ` +
        `save@${tickAtSave}, sphere rest y=${Transform.py[playerEid2].toFixed(3)}`,
    );
  } finally {
    for (const c of [client3, client2, client]) {
      try {
        await c?.close();
      } catch {
        /* ignore */
      }
    }
    try {
      await gw?.close();
    } catch {
      /* ignore */
    }
    try {
      physics2?.close();
    } catch {
      /* ignore */
    }
    try {
      physics?.close();
    } catch {
      /* ignore */
    }
    try {
      if (navBackend2) {
        if (tileRefs2) navBackend2.unloadTiles(tileRefs2);
        navBackend2.destroy();
      }
    } catch {
      /* ignore */
    }
    try {
      if (navBackend) {
        if (tileRefs) navBackend.unloadTiles(tileRefs);
        navBackend.destroy();
      }
    } catch {
      /* ignore */
    }
    try {
      registry2?.close();
    } catch {
      /* ignore */
    }
    try {
      registry?.close();
    } catch {
      /* ignore */
    }
    try {
      store2?.close();
    } catch {
      /* ignore */
    }
    try {
      store?.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

describe("integration: full scenario (phase 3 slice)", () => {
  it(
    "boots the real stack, walks a path, survives kill/restore — twice",
    { timeout: 600000 },
    async () => {
      await runScenario("run-1");
      // Fresh-process model for the second run in this process.
      SimWorld.resetEntityCursorForTesting();
      await runScenario("run-2");
    },
  );
});
