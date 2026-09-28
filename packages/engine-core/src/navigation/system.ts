/**
 * system.ts — NavigationSystem (Phase 2, slice 2.1).
 *
 * Batches path requests from PathRequest/PathState components into one
 * native findPaths call per tick and writes results back. Steering stays
 * JS-side (future slice) and reads the WaypointStore arena below.
 *
 * Data-oriented layout: PathState holds status + a slice descriptor
 * (offset/count); the dense WaypointStore arena holds the vectors, one
 * fixed slot per entity id (slot = eid * MAX_PATH_WAYPOINTS * 3). No
 * allocation at runtime, no indirection table, trivially serializable.
 * This is the DOD representation of `PathState { status, waypoints }`.
 */

import { defineQuery } from "bitecs";
import type { SimWorld } from "../world.js";
import {
  PathRequest,
  PathState,
  PathRequestStatus,
  MAX_PATH_WAYPOINTS,
  Transform,
} from "../components.js";
import type { SimSystem } from "../systems.js";
import {
  NAV_PATH_STATUS,
  type NavigationBackend,
  type FindPathsInput,
  type FindPathsOutput,
} from "./backend.js";

const pathQuery = defineQuery([PathRequest, PathState, Transform]);

/**
 * Dense waypoint arena: `capacity` entity slots of
 * MAX_PATH_WAYPOINTS xyz triples. Slot for eid starts at
 * `eid * MAX_PATH_WAYPOINTS * 3`.
 */
export class WaypointStore {
  readonly data: Float32Array;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`WaypointStore capacity must be > 0, got ${capacity}`);
    }
    this.data = new Float32Array(capacity * MAX_PATH_WAYPOINTS * 3);
  }

  /** Float offset of eid's slot in `data`. */
  slotOffset(eid: number): number {
    return eid * MAX_PATH_WAYPOINTS * 3;
  }
}

export interface NavigationSystemOptions {
  backend: NavigationBackend;
  /** Entity budget for scratch arenas + waypoint slots. Default 4096. */
  maxEntities?: number;
}

export class NavigationSystem implements SimSystem {
  readonly name = "NavigationSystem";
  readonly waypoints: WaypointStore;

  private readonly input: FindPathsInput;
  private readonly output: FindPathsOutput;
  /** Scratch: eid per batch slot, for write-back after the native call. */
  private readonly eids: Int32Array;
  private readonly capacity: number;

  constructor(private readonly options: NavigationSystemOptions) {
    this.capacity = options.maxEntities ?? 4096;
    this.waypoints = new WaypointStore(this.capacity);
    const c = this.capacity;
    this.input = {
      count: 0,
      entityIds: new BigUint64Array(c),
      start: new Float32Array(3 * c),
      end: new Float32Array(3 * c),
      profile: new Uint8Array(c),
      maxWaypoints: MAX_PATH_WAYPOINTS,
    };
    this.output = {
      status: new Int32Array(c),
      waypointCount: new Uint32Array(c),
      polyCount: new Uint32Array(c),
      waypoints: new Float32Array(3 * MAX_PATH_WAYPOINTS * c),
    };
    this.eids = new Int32Array(c);
  }

  step(sim: SimWorld, _dtSeconds: number): void {
    const entities = pathQuery(sim.ecs);
    const { input, output, eids } = this;

    // Collect new/changed requests: PathRequest.token != PathState.token.
    // One native call moves the whole batch (DOD: no per-entity calls).
    let n = 0;
    for (let k = 0; k < entities.length; k++) {
      const eid = entities[k];
      if (eid >= this.capacity) continue; // over budget: stays Idle, never crashes
      if (PathRequest.token[eid] === PathState.token[eid]) continue;
      PathState.status[eid] = PathRequestStatus.Pending;
      PathState.token[eid] = PathRequest.token[eid];
      PathState.waypointCount[eid] = 0;
      eids[n] = eid;
      input.entityIds[n] = sim.wireId(eid);
      input.start[n * 3] = Transform.px[eid];
      input.start[n * 3 + 1] = Transform.py[eid];
      input.start[n * 3 + 2] = Transform.pz[eid];
      input.end[n * 3] = PathRequest.x[eid];
      input.end[n * 3 + 1] = Transform.py[eid]; // y resolved by navmesh
      input.end[n * 3 + 2] = PathRequest.z[eid];
      input.profile[n] = PathRequest.profile[eid];
      n++;
    }
    if (n === 0) return;

    input.count = n;
    this.options.backend.findPaths(input, output);

    for (let i = 0; i < n; i++) {
      const eid = eids[i];
      if (output.status[i] === NAV_PATH_STATUS.Ok) {
        const count = Math.min(output.waypointCount[i], MAX_PATH_WAYPOINTS);
        const dst = this.waypoints.slotOffset(eid);
        const src = i * MAX_PATH_WAYPOINTS * 3;
        this.waypoints.data.set(
          output.waypoints.subarray(src, src + count * 3),
          dst,
        );
        PathState.status[eid] = PathRequestStatus.Active;
        PathState.waypointOffset[eid] = dst;
        PathState.waypointCount[eid] = count;
      } else {
        PathState.status[eid] = PathRequestStatus.Failed;
        PathState.waypointCount[eid] = 0;
      }
    }
  }
}
