/**
 * Shared authoring helpers (DRY): the small mechanics every admin
 * place/manage command needs — resolving a wire-id target, picking a
 * spawn point (explicit x/z or the admin's feet), and spawning a minimal
 * world entity. New authorable asset types build on these instead of
 * copy-pasting the gateway's spawn/attach logic.
 */

import { addComponent } from "bitecs";
import * as C from "../components.js";
import type { SimWorld } from "../world.js";
import type { ClientSession } from "../session.js";

/** A world position, or an error string when it can't be determined. */
export type SpawnPoint = { x: number; y: number; z: number } | { error: string };

/**
 * Resolve a wire-id string to a live entity, or -1 when it's not one.
 * Never throws (bad input reads as -1).
 */
export function resolveEntityTarget(world: SimWorld, target: string): number {
  try {
    return world.resolveWireId(BigInt(target));
  } catch {
    return -1;
  }
}

/**
 * Pick where to place something: explicit (x, z) with a ground snap, or
 * the calling admin's avatar when no coordinates are given.
 */
export function resolveSpawnPoint(
  world: SimWorld,
  s: ClientSession,
  groundHeightAt: ((x: number, z: number) => number) | null | undefined,
  x: number | undefined,
  z: number | undefined,
): SpawnPoint {
  if (x === undefined || z === undefined) {
    if (s.playerEntity === null) return { error: "no player entity (not in the world)" };
    const eid = world.resolveWireId(s.playerEntity);
    if (eid < 0) return { error: "avatar is gone" };
    return { x: C.Transform.px[eid], y: C.Transform.py[eid], z: C.Transform.pz[eid] };
  }
  return { x, y: groundHeightAt?.(x, z) ?? 0, z };
}

/**
 * Spawn a minimal world entity: a Transform at (x, y, z), nothing else.
 * Callers attach meaning (vendor template, NPC name, …) afterward.
 */
export function spawnBasicEntity(world: SimWorld, x: number, y: number, z: number): number {
  const eid = world.spawn();
  addComponent(world.ecs, C.Transform, eid);
  C.Transform.px[eid] = x;
  C.Transform.py[eid] = y;
  C.Transform.pz[eid] = z;
  return eid;
}
