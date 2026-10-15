/**
 * Region segmentation of a static quadruped mesh into a bone layout:
 * pure maths on a position array, no three.js (the rig turns it into bones).
 *
 * A static animal mesh has no skeleton, so the parts are found from its
 * shape: the longest horizontal axis is the spine, the end held higher off
 * the ground (the rear reaches down with hind legs) is the front, the belly
 * is where the footprint of a height slice fills in, and everything is
 * then cut into head, tail, four legs and body by smooth region weights
 * (so joints bend without cracks). Meshes that do not look like a
 * four-legged animal return null and stay static.
 *
 * Normalised frame (what `frame` maps the mesh into): +Z forward, +Y up,
 * feet on y = 0, centred on x = 0 and the middle of the spine.
 */

export const BONE_BODY = 0;
export const BONE_HEAD = 1;
export const BONE_TAIL = 2;
export const BONE_FL = 3;
export const BONE_FR = 4;
export const BONE_HL = 5;
export const BONE_HR = 6;
export const BONE_NAMES = ["body", "head", "tail", "legFL", "legFR", "legHL", "legHR"] as const;

export interface Frame {
  /** Rotation about +Y (radians) that turns the mesh to face +Z. */
  yaw: number;
  /** Translation applied after the rotation. */
  dx: number;
  dy: number;
  dz: number;
}

export interface Segmentation {
  frame: Frame;
  /** Size in the normalised frame. */
  length: number;
  height: number;
  width: number;
  /** Hip height: the leg length. */
  legLength: number;
  /** Bone pivots in the normalised frame, indexed by BONE_*. */
  pivots: Array<[number, number, number]>;
  /** Four bone indices and weights per vertex, in the mesh's own vertex order. */
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
}

export interface SegmentHints {
  /** Fraction of the height where the legs end (the belly); found from the shape when absent. */
  legTop?: number;
  /** +1 / -1 forces which end of the spine is the head, in the normalised frame's input order. */
  headSign?: 1 | -1;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Rotate (x, z) about +Y by yaw. */
function rot(x: number, z: number, yaw: number): [number, number] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [x * c + z * s, -x * s + z * c];
}

/** The frame that turns `positions` (xyz triples) to face +Z, stands them on y = 0 and centres them; null if not shaped like an animal. */
export function findFrame(positions: ArrayLike<number>, hints: SegmentHints = {}): Frame | null {
  const n = Math.floor(positions.length / 3);
  if (n < 12) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  // Spine along x or z; yaw0 turns the spine to z, then the head end is chosen.
  const alongX = x1 - x0 > z1 - z0;
  const base = alongX ? -Math.PI / 2 : 0; // (x, z) -> (-z, x): +x becomes +z
  const lo = alongX ? x0 : z0;
  const hi = alongX ? x1 : z1;
  const span = hi - lo;
  // Which end is the head: the head is held up, so its end's lowest point sits well above the ground,
  // while the rear end reaches down (hind legs, haunches, a hanging tail). Close calls go to the end
  // with more vertices (a head has more detail than a tail).
  let nLo = 0, nHi = 0, minLo = Infinity, minHi = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) if (positions[i * 3 + 1] > y1) y1 = positions[i * 3 + 1];
  for (let i = 0; i < n; i++) {
    const a = alongX ? positions[i * 3] : positions[i * 3 + 2];
    const y = positions[i * 3 + 1];
    if (a < lo + span * 0.12) {
      nLo++;
      if (y < minLo) minLo = y;
    } else if (a > hi - span * 0.12) {
      nHi++;
      if (y < minHi) minHi = y;
    }
  }
  const gap = (minHi - minLo) / Math.max(y1 - y0, 1e-6);
  const headHigh = hints.headSign !== undefined ? hints.headSign > 0 : Math.abs(gap) > 0.03 ? gap > 0 : nHi >= nLo;
  const yaw = base + (headHigh ? 0 : Math.PI);
  let cx0 = Infinity, cx1 = -Infinity, cz0 = Infinity, cz1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const [x, z] = rot(positions[i * 3], positions[i * 3 + 2], yaw);
    if (x < cx0) cx0 = x;
    if (x > cx1) cx1 = x;
    if (z < cz0) cz0 = z;
    if (z > cz1) cz1 = z;
  }
  return { yaw, dx: -(cx0 + cx1) / 2, dy: -y0, dz: -(cz0 + cz1) / 2 };
}

/** Normalised position of vertex i (writes `out`). */
function toFrame(p: ArrayLike<number>, i: number, f: Frame, out: [number, number, number]): void {
  const [x, z] = rot(p[i * 3], p[i * 3 + 2], f.yaw);
  out[0] = x + f.dx;
  out[1] = p[i * 3 + 1] + f.dy;
  out[2] = z + f.dz;
}

/** Where the belly is: the lowest height slice whose footprint is mostly filled in (a body, not four legs). */
function findLegTop(pts: Float32Array, n: number, L: number, W: number, H: number): number {
  const bands = 24, zc = 16, xc = 8;
  const cover = new Uint8Array(bands * zc * xc);
  for (let i = 0; i < n; i++) {
    const b = Math.min(bands - 1, Math.floor((pts[i * 3 + 1] / H) * bands));
    const iz = Math.min(zc - 1, Math.max(0, Math.floor((pts[i * 3 + 2] / L + 0.5) * zc)));
    const ix = Math.min(xc - 1, Math.max(0, Math.floor((pts[i * 3] / W + 0.5) * xc)));
    cover[(b * zc + iz) * xc + ix] = 1;
  }
  const filled: number[] = [];
  let most = 0;
  for (let b = 0; b < bands; b++) {
    let c = 0;
    for (let k = 0; k < zc * xc; k++) c += cover[b * zc * xc + k];
    filled.push(c);
    if (c > most) most = c;
  }
  for (let b = 0; b < bands; b++) if (filled[b] >= most * 0.55) return Math.min(0.6, Math.max(0.18, (b + 0.5) / bands));
  return 0.4;
}

/** Cut a quadruped mesh into bones. Null when it does not look like a four-legged animal. */
export function segmentQuadruped(positions: ArrayLike<number>, hints: SegmentHints = {}): Segmentation | null {
  const frame = findFrame(positions, hints);
  if (!frame) return null;
  const n = Math.floor(positions.length / 3);
  const pts = new Float32Array(n * 3);
  const tmp: [number, number, number] = [0, 0, 0];
  let xMin = Infinity, xMax = -Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < n; i++) {
    toFrame(positions, i, frame, tmp);
    pts[i * 3] = tmp[0];
    pts[i * 3 + 1] = tmp[1];
    pts[i * 3 + 2] = tmp[2];
    if (tmp[0] < xMin) xMin = tmp[0];
    if (tmp[0] > xMax) xMax = tmp[0];
    if (tmp[1] > yMax) yMax = tmp[1];
    if (tmp[2] < zMin) zMin = tmp[2];
    if (tmp[2] > zMax) zMax = tmp[2];
  }
  const L = zMax - zMin, H = yMax, W = Math.max(xMax - xMin, 1e-4);
  // A four-legged body is longer than it is tall; a pole, a tree, a snake or a bird in flight is not.
  if (L < 1e-3 || H < 1e-3 || L < H * 0.7 || W > L * 1.2) return null;

  const legTop = (hints.legTop ?? findLegTop(pts, n, L, W, H)) * H;
  const zMid = (zMin + zMax) / 2;
  const zNeck = zMax - 0.3 * L;
  const zRoot = zMin + 0.16 * L;

  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  // Weighted centroids of each leg's own vertices give the hip pivots.
  const legSum = [0, 1, 2, 3].map(() => ({ w: 0, x: 0, z: 0 }));
  let headY = 0, headW = 0, tailY = 0, tailW = 0;
  const cand = new Float32Array(7);
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
    const ax = Math.abs(x);
    const lateral = smooth(0.1 * W, 0.22 * W, ax); // 0 on the centreline (belly, tail), 1 out at a leg
    const legW = (1 - smooth(legTop * 0.7, legTop * 1.15, y)) * lateral;
    const front = smooth(zMid - 0.06 * L, zMid + 0.06 * L, z);
    const left = smooth(-0.08 * W, 0.08 * W, x);
    cand[BONE_FL] = legW * front * left;
    cand[BONE_FR] = legW * front * (1 - left);
    cand[BONE_HL] = legW * (1 - front) * left;
    cand[BONE_HR] = legW * (1 - front) * (1 - left);
    const room = 1 - legW;
    cand[BONE_HEAD] = room * smooth(zNeck - 0.05 * L, zNeck + 0.08 * L, z) * smooth(legTop * 0.9, legTop * 1.3, y);
    cand[BONE_TAIL] = room * (1 - smooth(zMin + 0.1 * L, zMin + 0.22 * L, z)) * (1 - lateral) * smooth(0.35 * legTop, 0.6 * legTop, y);
    let sum = 0;
    for (let b = 1; b < 7; b++) sum += cand[b];
    cand[BONE_BODY] = Math.max(0, 1 - sum);
    // Top four influences, normalised.
    let w4 = 0;
    for (let k = 0; k < 4; k++) {
      let best = -1, bw = 0;
      for (let b = 0; b < 7; b++) if (cand[b] > bw) { bw = cand[b]; best = b; }
      if (best < 0) break;
      skinIndex[i * 4 + k] = best;
      skinWeight[i * 4 + k] = bw;
      w4 += bw;
      cand[best] = 0;
    }
    if (w4 <= 0) {
      skinIndex[i * 4] = BONE_BODY;
      skinWeight[i * 4] = 1;
    } else for (let k = 0; k < 4; k++) skinWeight[i * 4 + k] /= w4;
    // Pivot statistics from vertices that belong clearly to a part.
    for (let k = 0; k < 4; k++) {
      const b = skinIndex[i * 4 + k], w = skinWeight[i * 4 + k];
      if (b >= BONE_FL && w > 0.8) {
        const s = legSum[b - BONE_FL];
        s.w += 1; s.x += x; s.z += z;
      } else if (b === BONE_HEAD && w > 0.8 && Math.abs(z - zNeck) < 0.06 * L) { headY += y; headW++; }
      else if (b === BONE_TAIL && w > 0.8 && z < zRoot + 0.05 * L) { tailY += y; tailW++; }
    }
  }
  const pivots: Array<[number, number, number]> = [];
  pivots[BONE_BODY] = [0, legTop, zMid];
  pivots[BONE_HEAD] = [0, headW > 0 ? headY / headW : 0.7 * H, zNeck];
  pivots[BONE_TAIL] = [0, tailW > 0 ? tailY / tailW : legTop * 1.05, zRoot];
  const quad = [
    [0.18 * W, zMid + 0.25 * L], [-0.18 * W, zMid + 0.25 * L],
    [0.18 * W, zMid - 0.25 * L], [-0.18 * W, zMid - 0.25 * L],
  ];
  for (let k = 0; k < 4; k++) {
    const s = legSum[k];
    pivots[BONE_FL + k] = s.w > 0 ? [s.x / s.w, legTop, s.z / s.w] : [quad[k][0], legTop, quad[k][1]];
  }
  return { frame, length: L, height: H, width: W, legLength: legTop, pivots, skinIndex, skinWeight };
}
