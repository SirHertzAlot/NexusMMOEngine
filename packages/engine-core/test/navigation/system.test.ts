// NavigationSystem tests (Phase 2, slice 2.1): batching, write-back,
// and the token protocol against a MOCK backend. The real N-API boundary
// is covered by the addon test suite; chunk-baker.test.ts exercises the
// real backend through the baker.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { SimWorld } from "../../src/world.js";
import {
  Transform,
  PathRequest,
  PathState,
  PathRequestStatus,
  MAX_PATH_WAYPOINTS,
} from "../../src/components.js";
import { NavigationSystem } from "../../src/navigation/system.js";
import {
  NAV_PATH_STATUS,
  type BakeTileConfig,
  type BakeTileResult,
  type NavigationBackend,
  type FindPathsInput,
  type FindPathsOutput,
} from "../../src/navigation/backend.js";

/** Mock backend: records batches, answers Ok with a canned 2-point path. */
class MockBackend implements NavigationBackend {
  batches: Array<{ count: number; profiles: number[] }> = [];
  failAll = false;

  bakeTile(
    _config: BakeTileConfig,
    _vertices: Float32Array,
    _indices: Uint32Array,
  ): BakeTileResult {
    throw new Error("not used");
  }
  loadTiles() {
    return new BigUint64Array(0);
  }
  unloadTiles() {}
  tileCount() {
    return 0;
  }
  findPaths(input: FindPathsInput, output: FindPathsOutput): void {
    this.batches.push({
      count: input.count,
      profiles: [...input.profile.slice(0, input.count)],
    });
    for (let i = 0; i < input.count; i++) {
      if (this.failAll) {
        output.status[i] = NAV_PATH_STATUS.NoPath;
        output.waypointCount[i] = 0;
        continue;
      }
      output.status[i] = NAV_PATH_STATUS.Ok;
      output.waypointCount[i] = 2;
      output.polyCount[i] = 1;
      const o = i * MAX_PATH_WAYPOINTS * 3;
      // Waypoint 0 = start, waypoint 1 = end (echo the request).
      output.waypoints[o] = input.start[i * 3];
      output.waypoints[o + 1] = input.start[i * 3 + 1];
      output.waypoints[o + 2] = input.start[i * 3 + 2];
      output.waypoints[o + 3] = input.end[i * 3];
      output.waypoints[o + 4] = input.end[i * 3 + 1];
      output.waypoints[o + 5] = input.end[i * 3 + 2];
    }
  }
  destroy() {}
}

function spawnWalker(
  sim: SimWorld,
  x: number,
  z: number,
  tx: number,
  tz: number,
  profile = 0,
): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  addComponent(sim.ecs, PathRequest, eid);
  addComponent(sim.ecs, PathState, eid);
  Transform.px[eid] = x;
  Transform.py[eid] = 0;
  Transform.pz[eid] = z;
  PathRequest.x[eid] = tx;
  PathRequest.z[eid] = tz;
  PathRequest.profile[eid] = profile;
  PathRequest.token[eid] = 1; // differs from PathState.token (0) -> new request
  return eid;
}

describe("NavigationSystem", () => {
  let sim: SimWorld;
  let backend: MockBackend;
  let system: NavigationSystem;

  beforeEach(() => {
    sim = new SimWorld();
    backend = new MockBackend();
    system = new NavigationSystem({ backend, maxEntities: 64 });
  });

  it("issues one native batch for N requests and writes back results", () => {
    const a = spawnWalker(sim, 0, 0, 10, 10);
    const b = spawnWalker(sim, 1, 1, 20, 20, 1);
    system.step(sim, 1 / 30);

    assert.equal(backend.batches.length, 1, "exactly one native call");
    assert.equal(backend.batches[0].count, 2);
    assert.deepEqual(backend.batches[0].profiles, [0, 1]);

    for (const eid of [a, b]) {
      assert.equal(PathState.status[eid], PathRequestStatus.Active);
      assert.equal(PathState.token[eid], 1);
      assert.equal(PathState.waypointCount[eid], 2);
      const off = PathState.waypointOffset[eid];
      assert.equal(off, eid * MAX_PATH_WAYPOINTS * 3);
      // Waypoint 1 echoes the requested target.
      assert.equal(system.waypoints.data[off + 3], PathRequest.x[eid]);
      assert.equal(system.waypoints.data[off + 5], PathRequest.z[eid]);
    }
  });

  it("does not re-issue requests whose token is unchanged", () => {
    spawnWalker(sim, 0, 0, 10, 10);
    system.step(sim, 1 / 30);
    assert.equal(backend.batches.length, 1);
    system.step(sim, 1 / 30);
    assert.equal(backend.batches.length, 1, "no new batch without token bump");
  });

  it("re-issues when the token is bumped", () => {
    const eid = spawnWalker(sim, 0, 0, 10, 10);
    system.step(sim, 1 / 30);
    PathRequest.x[eid] = 30;
    PathRequest.token[eid] = 2;
    system.step(sim, 1 / 30);
    assert.equal(backend.batches.length, 2);
    assert.equal(PathState.token[eid], 2);
    assert.equal(PathState.status[eid], PathRequestStatus.Active);
  });

  it("marks PathState Failed when the backend reports no path", () => {
    backend.failAll = true;
    const eid = spawnWalker(sim, 0, 0, 10, 10);
    system.step(sim, 1 / 30);
    assert.equal(PathState.status[eid], PathRequestStatus.Failed);
    assert.equal(PathState.waypointCount[eid], 0);
  });

  it("ignores entities without a full PathRequest/PathState/Transform set", () => {
    const eid = sim.spawn();
    addComponent(sim.ecs, Transform, eid); // no path components
    Transform.px[eid] = 5;
    system.step(sim, 1 / 30);
    assert.equal(backend.batches.length, 0);
  });
});
