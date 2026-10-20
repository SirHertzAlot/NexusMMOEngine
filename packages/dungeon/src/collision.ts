/**
 * What blocks a body in a baked dungeon. The grid walls are the layout's
 * own collider (an instance reads them from the walkable cells); props that
 * stand on the floor are round colliders, written into the file as
 * `colliders` so an instance needs nothing else to enforce them.
 *
 * Two sources: the layout's set pieces (a pillar blocks, a candle or a
 * banner does not: `LAYOUT_PROP_RADIUS` lists the ones that do) and the
 * dressing's props, by the `collision` of the dressing line they came from.
 * Torches hang on the wall surface and never block.
 */

import type { DungeonDressing } from "./dress.js";
import type { Dungeon } from "./generate.js";

/** A round obstacle: centre and radius, grid cells (continuous: cell (i, j) spans [i, i+1) x [j, j+1)). */
export interface Collider {
  x: number;
  y: number;
  r: number;
}

/**
 * Radius (cells) of the layout props that block. Kept under 0.75 so a body
 * standing on the next cell over (a cell away: the nearest a spawn goes)
 * is clear of it.
 */
export const LAYOUT_PROP_RADIUS: Readonly<Record<string, number>> = {
  pillar: 0.4,
  grave: 0.35,
  sarcophagus: 0.75,
  chest: 0.5,
  bossCrystal: 0.6,
  shrineCrystal: 0.5,
  brazier: 0.35,
};

export function dungeonColliders(d: Dungeon, dressing?: DungeonDressing): Collider[] {
  const out: Collider[] = [];
  // A layout prop sits on a cell: its centre is the cell's.
  for (const p of d.props) {
    const r = LAYOUT_PROP_RADIUS[p.kind];
    if (r) out.push({ x: p.x + 0.5, y: p.y + 0.5, r });
  }
  for (const p of dressing?.props ?? []) if (p.collision === "solid") out.push({ x: p.x, y: p.y, r: p.radius });
  return out;
}
