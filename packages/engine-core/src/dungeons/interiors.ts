/**
 * Room interiors at runtime: the bake's interior grammar (the dungeon package's
 * interiors.ts) lays each room's walls and floor as model parts. Each part becomes
 * a static entity at its room's origin, drawn as the model it names. The walkable
 * grid keeps the collision, so a part carries no body.
 */

import { fnv1a32 } from "@mmo-engine/picg";
import type { InstanceLayout } from "./pool.js";

/** One interior part as the run spawns it: a model at a world position, turned and scaled. */
export interface InteriorSpawn {
  /** World position, metres: the room's origin plus the part's offset. */
  x: number;
  y: number;
  z: number;
  /** Rotation quaternion, x y z w. */
  rot: [number, number, number, number];
  scale: [number, number, number];
  /** The hash of the model's asset id, which an AssetRef carries. */
  assetHash: number;
}

/** Every interior part of a layout, in the order the bake laid them (empty when none were laid). */
export function interiorSpawns(layout: InstanceLayout): InteriorSpawn[] {
  return (layout.interiors ?? []).flatMap((room) =>
    room.placements.map((p) => ({
      x: room.origin[0] + p.pos[0],
      y: p.pos[1],
      z: room.origin[1] + p.pos[2],
      rot: p.rot,
      scale: p.scale,
      assetHash: fnv1a32(p.assetRef),
    })),
  );
}
