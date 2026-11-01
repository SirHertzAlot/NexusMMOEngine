/**
 * Road surface mesh (roadmap SG2b, client side). The engine-core spline (`splineRoads`) gives each
 * road a draped ribbon: a centreline and a left and right rail, one sample per point. This turns
 * the rails into a triangle strip with positions and indices, ready for a three.js BufferGeometry.
 *
 * Pure arrays on purpose: no three import, so it runs in the client test suite and the browser
 * preview alike. The surface sits `lift` metres above the terrain so it does not z-fight the ground.
 */

/** A draped ribbon as engine-core produces it: x, y, z triples, one per sample along the road. */
export interface RoadRibbonInput {
  readonly left: ArrayLike<number>;
  readonly right: ArrayLike<number>;
}

export interface RoadStrip {
  /** x, y, z per vertex: the left rail's samples, then the right rail's. */
  readonly positions: Float32Array;
  /** Two counter-clockwise triangles per segment, seen from above. */
  readonly indices: Uint32Array;
}

/** Default surface lift above the terrain, in metres. */
export const ROAD_LIFT_M = 0.03;

/**
 * Build the strip for one ribbon. Returns an empty strip when there are fewer than two samples
 * or the rails disagree in length (a malformed ribbon draws nothing rather than a broken mesh).
 */
export function roadStrip(ribbon: RoadRibbonInput, lift: number = ROAD_LIFT_M): RoadStrip {
  const n = Math.floor(ribbon.left.length / 3);
  if (n < 2 || ribbon.right.length !== ribbon.left.length) {
    return { positions: new Float32Array(0), indices: new Uint32Array(0) };
  }
  const positions = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const src = i * 3;
    const li = i * 3; // left vertex i
    const ri = (n + i) * 3; // right vertex i, after the left rail
    positions[li] = ribbon.left[src];
    positions[li + 1] = ribbon.left[src + 1] + lift;
    positions[li + 2] = ribbon.left[src + 2];
    positions[ri] = ribbon.right[src];
    positions[ri + 1] = ribbon.right[src + 1] + lift;
    positions[ri + 2] = ribbon.right[src + 2];
  }
  const indices = new Uint32Array((n - 1) * 6);
  for (let i = 0; i < n - 1; i++) {
    const a = i, b = i + 1, c = n + i, d = n + i + 1;
    const o = i * 6;
    // Winding chosen so the top face points up when the rails run left to right along the road.
    indices[o + 0] = a; indices[o + 1] = b; indices[o + 2] = c;
    indices[o + 3] = b; indices[o + 4] = d; indices[o + 5] = c;
  }
  return { positions, indices };
}
