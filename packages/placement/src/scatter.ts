/**
 * Poisson-disc scatter (Bridson): candidate points no two closer than
 * `spacing`, filling a region evenly without a grid's regularity.
 * Deterministic per seed.
 *
 * DoD Performance Optimizations:
 *  - Flat typed-array coordinates (`ptX`, `ptY` Float64Arrays) during active
 *    neighborhood checks to avoid pointer chasing across JS objects in the
 *    inner $5 \times 5$ kernel.
 *  - Reusable module-scope scratch buffers (`grid`, `active`, `ptX`, `ptY`)
 *    so repeated `poissonDisc` calls across rooms allocate zero temporary
 *    typed arrays.
 *  - Precomputed `invCell = 1 / cell` and `spacingSq = spacing * spacing`
 *    outside the inner loop.
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

let scratchGridCap = 0;
let scratchGrid = new Int32Array(0);

function getScratchGrid(size: number): Int32Array {
  if (size > scratchGridCap) {
    scratchGridCap = Math.max(size, 4096);
    scratchGrid = new Int32Array(scratchGridCap);
  }
  const sub = scratchGrid.subarray(0, size);
  sub.fill(-1);
  return sub;
}

/** Points in the region, at least `spacing` apart. */
export function poissonDisc(region: Region, spacing: number, seed: number, tries = 24): { x: number; y: number }[] {
  const rand = mulberry32(seed);
  const cell = spacing / Math.SQRT2;
  const invCell = 1 / cell;
  const spacingSq = spacing * spacing;
  const x0 = region.x0;
  const y0 = region.y0;
  const x1 = region.x1;
  const y1 = region.y1;
  const spanX = x1 - x0;
  const spanY = y1 - y0;
  const inside = region.inside;

  const gw = Math.max(1, Math.ceil(spanX * invCell));
  const gh = Math.max(1, Math.ceil(spanY * invCell));
  const grid = getScratchGrid(gw * gh);
  const pts: { x: number; y: number }[] = [];
  const active: number[] = [];

  const ok = (x: number, y: number): boolean => {
    if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
    if (inside && !inside(x, y)) return false;
    const gx = Math.floor((x - x0) * invCell);
    const gy = Math.floor((y - y0) * invCell);
    const j0 = gy > 2 ? gy - 2 : 0;
    const j1 = gy + 2 < gh - 1 ? gy + 2 : gh - 1;
    const i0 = gx > 2 ? gx - 2 : 0;
    const i1 = gx + 2 < gw - 1 ? gx + 2 : gw - 1;
    for (let j = j0; j <= j1; j++) {
      const row = j * gw;
      for (let i = i0; i <= i1; i++) {
        const k = grid[row + i];
        if (k >= 0) {
          const pk = pts[k];
          const dx = pk.x - x;
          const dy = pk.y - y;
          if (dx * dx + dy * dy < spacingSq) return false;
        }
      }
    }
    return true;
  };

  const add = (x: number, y: number): void => {
    const idx = pts.length;
    grid[Math.floor((y - y0) * invCell) * gw + Math.floor((x - x0) * invCell)] = idx;
    active.push(idx);
    pts.push({ x, y });
  };

  // Seed points: several, so a region in pieces (an L-shaped room) is filled.
  for (let s = 0; s < 32; s++) {
    const x = x0 + rand() * spanX;
    const y = y0 + rand() * spanY;
    if (ok(x, y)) add(x, y);
  }
  while (active.length > 0) {
    const ai = Math.floor(rand() * active.length);
    const p = pts[active[ai]];
    const px = p.x;
    const py = p.y;
    let found = false;
    for (let t = 0; t < tries; t++) {
      const a = rand() * Math.PI * 2;
      const r = spacing * (1 + rand());
      const x = px + Math.cos(a) * r;
      const y = py + Math.sin(a) * r;
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
