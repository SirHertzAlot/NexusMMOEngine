/**
 * Walkability: which land can be reached on foot from a start cell. A step
 * between neighbouring cells (8 directions) is walkable when the climb over
 * the run is within the slope limit and neither cell is blocked (water), so
 * a plateau ringed by cliffs, or a tread with no ramp up its riser, is
 * stranded. Settlement site selection applies the same rule (sites.ts in
 * @mmo-engine/settlement keeps its own copy: the packages don't depend on
 * each other).
 */

/**
 * 1 on every cell reachable from `from` (a cell index), 0 elsewhere (all 0
 * when the start itself is blocked). `blocked` marks cells that can't be
 * walked at all; heights are metres, `grid.cell` metres per cell.
 */
export function reachableLand(
  heights: Float32Array,
  grid: { width: number; depth: number; cell: number },
  slopeLimitDeg: number,
  from: number,
  blocked?: (i: number) => boolean,
): Uint8Array {
  const { width: W, depth: D, cell } = grid;
  const out = new Uint8Array(W * D);
  if (from < 0 || from >= W * D || blocked?.(from)) return out;
  const tan = Math.tan((slopeLimitDeg * Math.PI) / 180);
  const queue = new Int32Array(W * D);
  let head = 0;
  let tail = 0;
  out[from] = 1;
  queue[tail++] = from;
  while (head < tail) {
    const i = queue[head++];
    const u = i % W;
    const v = (i - u) / W;
    for (let dv = -1; dv <= 1; dv++) {
      for (let du = -1; du <= 1; du++) {
        if (du === 0 && dv === 0) continue;
        const nu = u + du;
        const nv = v + dv;
        if (nu < 0 || nv < 0 || nu >= W || nv >= D) continue;
        const j = nv * W + nu;
        if (out[j] || blocked?.(j)) continue;
        const run = du !== 0 && dv !== 0 ? cell * Math.SQRT2 : cell;
        if (Math.abs(heights[j] - heights[i]) > tan * run) continue;
        out[j] = 1;
        queue[tail++] = j;
      }
    }
  }
  return out;
}
