/**
 * The collider of a baked prop (scatter, ecology, formation, PICG tree),
 * worked out once at spawn: the model's bounds x the instance's scale, or
 * the spawn table's explicit shape. Everything reads the BodyConfig this
 * fills: the Jolt body, the nav obstacle and PropCollisionSystem.
 *
 * Bounds come from the art catalog (assets/catalog.json, local only) or the
 * PICG cook; a model of unknown size falls back to the default box.
 */

import { readFileSync } from "node:fs";
import { decodePcgMesh } from "@mmo-engine/picg";
import type { EntitySpawn } from "@mmo-engine/scatter";
import type { PcgAssetLibrary } from "../pcg/asset-library.js";

/** A model's size in metres [x, y, z] (base on the ground), by asset id. */
export type ModelBounds = (assetId: string) => readonly [number, number, number] | undefined;

/** A prop lower than this is stepped over, not a wall (leaf litter, a flower). */
export const STEP_OVER_M = 0.25;
const MIN_HALF = 0.05;

export type PropShape =
  | { kind: "none" }
  | { kind: "box"; hx: number; hy: number; hz: number }
  | { kind: "sphere"; r: number };

/**
 * The shape a spawn's collider should have, or null when nothing is known
 * (no spec and no bounds: the caller's default box).
 *
 * Boxes and spheres are centred on the prop's position, at ground level, so
 * a box's halfY is the full scaled height (its top is the model's top).
 * Explicit halfExtents/radius are authored at scale 1.
 */
export function propShape(s: EntitySpawn, bounds?: ModelBounds): PropShape | null {
  const col = s.archetype.collision;
  if (col?.shape === "none") return { kind: "none" };
  const sx = Math.abs(s.sx), sy = Math.abs(s.sy), sz = Math.abs(s.sz);
  const size = bounds?.(s.assetId);
  const fit = col?.fit ?? 1;
  if (col?.shape === "sphere") {
    if (col.radius) return { kind: "sphere", r: Math.max(col.radius * Math.max(sx, sz), MIN_HALF) };
    return size ? { kind: "sphere", r: Math.max((Math.max(size[0] * sx, size[2] * sz) / 2) * fit, MIN_HALF) } : null;
  }
  if (col?.halfExtents) {
    const he = col.halfExtents;
    return { kind: "box", hx: Math.max(he[0] * sx, MIN_HALF), hy: Math.max(he[1] * sy, MIN_HALF), hz: Math.max(he[2] * sz, MIN_HALF) };
  }
  if (!size) return null;
  if (size[1] * sy < STEP_OVER_M) return { kind: "none" };
  return {
    kind: "box",
    hx: Math.max((size[0] * sx * fit) / 2, MIN_HALF),
    hy: Math.max(size[1] * sy, MIN_HALF),
    hz: Math.max((size[2] * sz * fit) / 2, MIN_HALF),
  };
}

/** Model sizes from the art catalog file (assets/catalog.json: models[].id and size). */
export function catalogBounds(file: string): ModelBounds {
  const models = (JSON.parse(readFileSync(file, "utf8")) as { models: Array<{ id: string; size?: number[] }> }).models;
  const sizes = new Map<string, [number, number, number]>();
  for (const m of models) if (m.size?.length === 3) sizes.set(m.id, [m.size[0], m.size[1], m.size[2]]);
  return (id) => sizes.get(id);
}

/** Sizes of the PICG library's assets, from their cooked meshes (the largest across variants). Needs the native cook. */
export async function pcgBounds(library: PcgAssetLibrary): Promise<ModelBounds> {
  const sizes = new Map<string, [number, number, number]>();
  for (const info of library.list()) {
    const size: [number, number, number] = [0, 0, 0];
    for (let v = 0; v < info.variants; v++) {
      const cooked = await library.mesh(info.assetHash, v);
      if (!cooked) continue;
      const p = decodePcgMesh(cooked.bytes).positions;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.length; i++) {
        lo[i % 3] = Math.min(lo[i % 3], p[i]);
        hi[i % 3] = Math.max(hi[i % 3], p[i]);
      }
      for (let a = 0; a < 3; a++) size[a] = Math.max(size[a], hi[a] - lo[a]);
    }
    if (size[1] > 0) sizes.set(info.id, size);
  }
  return (id) => sizes.get(id);
}
