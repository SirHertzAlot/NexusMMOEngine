/**
 * DebugSource — the narrow, read-only, injected seam behind the
 * gateway's editor debug queries (protocol v3, message 0x0a).
 *
 * Design (EDA / "dumb pipes, smart endpoints"):
 * - The gateway is an event translator: it validates, authenticates,
 *   and encodes. It must NOT reach into simulation internals, hunt for
 *   systems with `instanceof`, or read component stores directly.
 * - This interface is the gateway's ONLY window into sim state for
 *   debug tooling. Production composes it from the live SimWorld,
 *   NavigationSystem, and loaded-tile bookkeeping; tests inject fakes.
 * - Everything here is read-only: no mutation APIs exist on this
 *   surface, so debug queries can never disturb the authoritative sim.
 *
 * @module
 */

import { defineQuery, hasComponent } from "bitecs";
import type { DebugCollider, DebugResponse } from "@mmo-engine/protocol";
import * as C from "../components.js";
import type { NavigationSystem } from "../navigation/system.js";
import type { SimWorld } from "../world.js";

/** Read-only debug answers for the editor's play-mode overlays. */
export interface DebugSource {
  /**
   * Bounds of the navmesh tiles currently LOADED into the navigation
   * backend, as [minX, minZ, maxX, maxZ]. Not "all known tiles" —
   * the overlay draws what pathfinding can actually use.
   */
  tiles(): Array<[number, number, number, number]>;
  /**
   * Waypoint peek for an entity wire id. Returns `status: "unknown"`
   * (with an empty waypoint list) for malformed ids, never-used
   * slots, stale generations, and despawned entities.
   */
  waypoints(
    entityWireId: string,
  ): Extract<DebugResponse, { query: "waypoints" }>;
  /**
   * Collision bodies centred within `radius` m of (x, z): static boxes
   * and spheres plus kinematic capsules. At most MAX_DEBUG_COLLIDERS are
   * listed; `total` counts every match.
   */
  colliders(
    x: number,
    z: number,
    radius: number,
  ): Extract<DebugResponse, { query: "colliders" }>;
}

/** The most bodies one colliders answer lists (keeps the JSON frame small). */
export const MAX_DEBUG_COLLIDERS = 4000;

const bodies = defineQuery([C.Transform, C.BodyConfig]);

export interface DebugSourceDeps {
  world: SimWorld;
  /** Null when the sim runs without navigation (debug answers "unknown"). */
  navigation: NavigationSystem | null;
  /** Currently loaded tile bounds — owned by whoever loads tiles. */
  loadedTileBounds: () => Array<[number, number, number, number]>;
}

/**
 * Compose the production debug source. The waypoint peek mirrors what
 * the delta stream intentionally omits: path waypoints live in the
 * server-side WaypointStore, never on the wire.
 */
export function makeDebugSource(deps: DebugSourceDeps): DebugSource {
  const { world, navigation, loadedTileBounds } = deps;
  return {
    tiles: () => loadedTileBounds(),
    colliders: (x, z, radius) => {
      const colliders: DebugCollider[] = [];
      let total = 0;
      if (![x, z, radius].every(Number.isFinite)) return { kind: "debug", query: "colliders", colliders, total };
      const r2 = radius * radius;
      for (const e of bodies(world.ecs)) {
        const motion = C.BodyConfig.motionType[e];
        const shape = C.BodyConfig.shapeKind[e];
        const capsule = shape === C.ShapeKind.Capsule;
        // Static boxes/spheres block characters; kinematic capsules are the characters.
        if (motion === C.MotionType.Static ? capsule : !(motion === C.MotionType.Kinematic && capsule)) continue;
        const dx = C.Transform.px[e] - x;
        const dz = C.Transform.pz[e] - z;
        if (dx * dx + dz * dz > r2) continue;
        total++;
        if (colliders.length >= MAX_DEBUG_COLLIDERS) continue;
        const qx = C.Transform.qx[e];
        const qy = C.Transform.qy[e];
        const qz = C.Transform.qz[e];
        const qw = C.Transform.qw[e];
        colliders.push({
          id: String(world.wireId(e)),
          shape: shape as 0 | 1 | 2,
          motion: motion as 0 | 1 | 2,
          x: C.Transform.px[e],
          y: C.Transform.py[e],
          z: C.Transform.pz[e],
          hx: C.BodyConfig.halfX[e],
          hy: C.BodyConfig.halfY[e],
          hz: C.BodyConfig.halfZ[e],
          r: C.BodyConfig.radius[e],
          // Yaw about +Y, extracted as NavObstacleSystem / PropCollisionSystem do.
          yaw: Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qx * qx + qy * qy)),
          asset: hasComponent(world.ecs, C.AssetRef, e) ? C.AssetRef.assetHash[e] : 0,
        });
      }
      return { kind: "debug", query: "colliders", colliders, total };
    },
    waypoints: (entityWireId) => {
      const unknown: Extract<DebugResponse, { query: "waypoints" }> = {
        kind: "debug",
        query: "waypoints",
        entity: entityWireId,
        status: "unknown",
        waypoints: [],
      };
      let wireId: bigint;
      try {
        wireId = BigInt(entityWireId);
      } catch {
        return { ...unknown };
      }
      if (!navigation) return { ...unknown };
      // Validate against the live world: stale, despawned, or
      // never-used slots resolve to -1 (a never-used slot has no
      // generation entry, so generation-0 queries can't false-positive).
      const eid = world.resolveWireId(wireId);
      if (eid < 0) return { ...unknown };
      const statusNum = C.PathState.status[eid];
      const status =
        statusNum === C.PathRequestStatus.Active
          ? "active"
          : statusNum === C.PathRequestStatus.Failed
            ? "failed"
            : "idle";
      const count = C.PathState.waypointCount[eid];
      const waypoints: Array<[number, number, number]> = [];
      if (status === "active" && count > 0) {
        const off = C.PathState.waypointOffset[eid];
        const data = navigation.waypoints.data;
        for (let i = 0; i < count; i++) {
          waypoints.push([
            data[off + i * 3],
            data[off + i * 3 + 1],
            data[off + i * 3 + 2],
          ]);
        }
      }
      return {
        kind: "debug",
        query: "waypoints",
        entity: entityWireId,
        status,
        waypoints,
      };
    },
  };
}
