/**
 * Poisson-disc scatter (Bridson): candidate points no two closer than
 * `spacing`, filling a region evenly without a grid's regularity.
 * Deterministic per seed.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Whether a point in the box belongs (default: all of it). */
  inside?: (x: number, y: number) => boolean;
}

/** Points in the region, at least `spacing` apart. */
export function poissonDisc(region: Region, spacing: number, seed: number, tries = 24): { x: number; y: number }[] {
  const rand = mulberry32(seed);
  const cell = spacing / Math.SQRT2;
  const gw = Math.max(1, Math.ceil((region.x1 - region.x0) / cell));
  const gh = Math.max(1, Math.ceil((region.y1 - region.y0) / cell));
  const grid = new Int32Array(gw * gh).fill(-1);
  const pts: { x: number; y: number }[] = [];
  const active: number[] = [];
  const ok = (x: number, y: number): boolean => {
    if (x < region.x0 || x >= region.x1 || y < region.y0 || y >= region.y1) return false;
    if (region.inside && !region.inside(x, y)) return false;
    const gx = Math.floor((x - region.x0) / cell), gy = Math.floor((y - region.y0) / cell);
    for (let j = Math.max(0, gy - 2); j <= Math.min(gh - 1, gy + 2); j++)
      for (let i = Math.max(0, gx - 2); i <= Math.min(gw - 1, gx + 2); i++) {
        const k = grid[j * gw + i];
        if (k >= 0 && (pts[k].x - x) ** 2 + (pts[k].y - y) ** 2 < spacing * spacing) return false;
      }
    return true;
  };
  const add = (x: number, y: number): void => {
    grid[Math.floor((y - region.y0) / cell) * gw + Math.floor((x - region.x0) / cell)] = pts.length;
    active.push(pts.length);
    pts.push({ x, y });
  };
  // Seed points: several, so a region in pieces (an L-shaped room) is filled.
  for (let s = 0; s < 32; s++) {
    const x = region.x0 + rand() * (region.x1 - region.x0), y = region.y0 + rand() * (region.y1 - region.y0);
    if (ok(x, y)) add(x, y);
  }
  while (active.length > 0) {
    const ai = Math.floor(rand() * active.length);
    const p = pts[active[ai]];
    let found = false;
    for (let t = 0; t < tries; t++) {
      const a = rand() * Math.PI * 2, r = spacing * (1 + rand());
      const x = p.x + Math.cos(a) * r, y = p.y + Math.sin(a) * r;
      if (ok(x, y)) {
        add(x, y);
        found = true;
        break;
      }
    }
    if (!found) active.splice(ai, 1);
  }
  return pts;
}
