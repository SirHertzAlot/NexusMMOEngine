/**
 * Placement: WFC has decided what goes in a space ("a sarcophagus in the
 * middle, two candles in corners, a weapon rack on a wall"); this decides
 * where. Scatter proposes candidate spots through the space, and the
 * raymarcher checks and settles each item against the space's distance
 * field:
 *
 *  - floor:  anywhere with `radius` of clearance;
 *  - centre: the most open spot (the field's largest value);
 *  - wall:   march from a candidate to the nearest wall and stand against
 *            it, facing out (or `mount` it on the wall surface);
 *  - corner: a wall spot where a second wall is within reach along the
 *            first one.
 *
 * Items are placed in order (list the big ones first); each keeps clear of
 * those already placed. Deterministic per seed.
 */

import { march2, march3, normal2 } from "./raymarch.js";
import { mulberry32, poissonDisc, type Region } from "./scatter.js";
import type { Sdf2, Sdf3 } from "./sdf.js";

export type Where = "floor" | "centre" | "wall" | "corner";

export interface PlaceItem {
  where: Where;
  /** Footprint radius (world units): its clearance, and how far it stays from other items. */
  radius: number;
  /** Mounted on the wall surface (a torch, a vein) rather than standing against it. */
  mount?: boolean;
}

export interface Placed {
  x: number;
  y: number;
  /** Facing, radians (wall items face out of the wall). */
  rot: number;
  /** The wall's normal, for wall and corner items. */
  nx?: number;
  ny?: number;
  radius: number;
}

export interface PlaceOptions {
  seed: number;
  /** Candidate spacing (default: the smallest radius, at least 0.25). */
  spacing?: number;
  /** Already there: items keep clear of these. */
  taken?: readonly Placed[];
  /** How far a wall item may be from its wall (default 3). */
  reach?: number;
}

/** Place each item in the region; null where there's no room for it. */
export function placeInRegion(sdf: Sdf2, region: Region, items: readonly PlaceItem[], o: PlaceOptions): (Placed | null)[] {
  const rand = mulberry32(o.seed ^ 0x51ac3);
  const spacing = o.spacing ?? Math.max(0.25, Math.min(...items.map((i) => i.radius)));
  const cands = poissonDisc(region, spacing, o.seed);
  const placed: Placed[] = [...(o.taken ?? [])];
  const reach = o.reach ?? 3;
  const clear = (x: number, y: number, r: number): boolean => placed.every((p) => (p.x - x) ** 2 + (p.y - y) ** 2 >= (p.radius + r) ** 2);
  const inRegion = (x: number, y: number): boolean =>
    x >= region.x0 && x < region.x1 && y >= region.y0 && y < region.y1 && (!region.inside || region.inside(x, y));

  // Settle a candidate against its nearest wall (null if none within reach).
  const toWall = (x: number, y: number, it: PlaceItem): Placed | null => {
    // Only from clearly open space (a sampled field dips below zero near corners).
    if (sdf.distance(x, y) < 0.05) return null;
    const [nx, ny] = normal2(sdf, x, y);
    const hit = march2(sdf, x, y, -nx, -ny, { maxDistance: reach });
    if (!hit) return null;
    const off = it.mount ? 0.01 : it.radius;
    const px = hit.x + hit.nx * off, py = hit.y + hit.ny * off;
    if (!inRegion(px, py) || (!it.mount && sdf.distance(px, py) < it.radius - 1e-6)) return null;
    return { x: px, y: py, rot: Math.atan2(hit.ny, hit.nx), nx: hit.nx, ny: hit.ny, radius: it.radius };
  };

  const out: (Placed | null)[] = [];
  for (const it of items) {
    // Shuffle the candidates for this item (deterministically), then take the first that fits.
    const order = cands.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let got: Placed | null = null;
    if (it.where === "centre") {
      // The most open candidates first.
      order.sort((a, b) => sdf.distance(cands[b].x, cands[b].y) - sdf.distance(cands[a].x, cands[a].y) || a - b);
    }
    for (const k of order) {
      const c = cands[k];
      let p: Placed | null = null;
      if (it.where === "floor" || it.where === "centre") {
        if (sdf.distance(c.x, c.y) >= it.radius) p = { x: c.x, y: c.y, rot: rand() * Math.PI * 2, radius: it.radius };
      } else {
        p = toWall(c.x, c.y, it);
        if (p && it.where === "corner") {
          // Along the wall either way: another wall close by makes a corner.
          const tx = -(p.ny as number), ty = p.nx as number;
          const near = (s: number): boolean => march2(sdf, p!.x, p!.y, tx * s, ty * s, { maxDistance: it.radius * 2 + 0.5 }) !== null;
          if (!near(1) && !near(-1)) p = null;
        }
      }
      if (p && clear(p.x, p.y, p.radius)) {
        got = p;
        break;
      }
    }
    if (got) placed.push(got);
    out.push(got);
  }
  return out;
}

/** Drop a point onto terrain: march down from above to the ground; its height and the ground's normal. */
export function snapToGround(sdf: Sdf3, x: number, z: number, fromY: number, maxDrop = 1e4): { y: number; normal: [number, number, number] } | null {
  const hit = march3(sdf, x, fromY, z, 0, -1, 0, { maxDistance: maxDrop, maxSteps: 512 });
  return hit ? { y: hit.y, normal: [hit.nx, hit.ny, hit.nz] } : null;
}
