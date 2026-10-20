/**
 * Habitat: where on the world's water things may stand. Below the water
 * (sea or lake) is for aquatic content only (coral, kelp, lily pads); land
 * content (trees, props, buildings) needs its ground a margin above the surface.
 * One source for it: the sea level (world spec, stored as meta `sea_level`) and the
 * water-surface lookup built from the bake's `water_level` map; every placement path
 * (ecology, PCG scatter, wild packs, scene nodes) asks here.
 */

/** Land content stands at least this far above the water surface, metres (an ecology plan's `landMarginM` overrides it). */
export const LAND_MARGIN_M = 0.3;
/** Buildings want wetter-footing room: this far above the water surface under their whole footprint, metres. */
export const STRUCTURE_MARGIN_M = 1;

export type Habitat = "land" | "shore" | "water";
export const HABITATS: readonly Habitat[] = ["land", "shore", "water"];

/** The water surface at (x, z): the higher of the sea and the lake/sea lookup; null where the world has no water at all. */
export function surfaceAt(waterAt: ((x: number, z: number) => number | null) | undefined, seaLevel: number | undefined, x: number, z: number): number | null {
  const w = waterAt ? waterAt(x, z) : null;
  if (w === null) return seaLevel ?? null;
  return seaLevel === undefined ? w : Math.max(w, seaLevel);
}

/**
 * The water a layer's `aboveWater` band is measured against: the lookup where the world has one (null where no
 * water is near, so a shore layer only grows by water), else the sea level. Not the sea floor fallback `surfaceAt` adds.
 */
export function bandSurfaceAt(waterAt: ((x: number, z: number) => number | null) | undefined, seaLevel: number | undefined, x: number, z: number): number | null {
  return waterAt ? waterAt(x, z) : seaLevel ?? null;
}

/** Dry enough for land content: ground at least `margin` above the surface (always, with no water). */
export function landDry(ground: number, surface: number | null, margin: number): boolean {
  return surface === null || ground - surface >= margin;
}

/**
 * May a layer put something at this ground height over this water surface? Its own
 * `aboveWater` band always applies (a shore's strip, a coral's depths: ground minus surface);
 * a land layer (the default) also needs the margin, so nothing lands in or at the water.
 */
export function habitatOk(layer: { habitat?: Habitat; aboveWater?: [number, number | null] }, marginM: number, ground: number, surface: number | null, bandSurface: number | null = surface): boolean {
  if (layer.aboveWater) {
    const above = bandSurface === null ? Infinity : ground - bandSurface;
    const [lo, hi] = layer.aboveWater;
    if (above < lo || (hi !== null && above > hi)) return false;
  }
  return (layer.habitat ?? "land") !== "land" || landDry(ground, surface, marginM);
}

/** habitatOk for a spawn-table archetype (habitat "land" by default; "water" with its depthM). */
export function archetypeOk(a: { habitat?: "land" | "water"; depthM?: [number, number] }, marginM: number, ground: number, surface: number | null): boolean {
  return habitatOk({ habitat: a.habitat, ...(a.depthM ? { aboveWater: [-a.depthM[1], -a.depthM[0]] as [number, number] } : {}) }, marginM, ground, surface);
}

/** True where the survey's river map has a river at (x, z) (its nearest cell). */
export function riverAtFromMap(map: { width: number; depth: number; cell: number; originX: number; originZ: number; data: ArrayLike<number> }): (x: number, z: number) => boolean {
  return (x, z) => {
    const u = Math.round((x - map.originX) / map.cell);
    const v = Math.round((z - map.originZ) / map.cell);
    return u >= 0 && v >= 0 && u < map.width && v < map.depth && map.data[v * map.width + u] !== 0;
  };
}
