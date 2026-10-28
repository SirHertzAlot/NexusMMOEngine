/**
 * Region segmentation of a static quadruped mesh into a bone layout:
 * pure maths on a position array, no three.js (the rig turns it into bones).
 *
 * A static animal mesh has no skeleton, so the parts are found from its
 * shape: the longest horizontal axis is the spine, the end held higher off
 * the ground (the rear reaches down with hind legs) is the front, the belly
 * is where the footprint of a height slice fills in, and everything is
 * then cut into head, tail, body and four two-segment legs (upper leg
 * from the hip, lower leg from the knee) by smooth region weights
 * (so joints bend without cracks). Meshes that do not look like a
 * four-legged animal return null and stay static.
 *
 * Normalised frame (what `frame` maps the mesh into): +Z forward, +Y up,
 * feet on y = 0, centred on x = 0 and the middle of the spine.
 */

export const BONE_BODY = 0;
export const BONE_HEAD = 1;
export const BONE_TAIL = 2;
/** Upper leg bones (swing at hip/shoulder): FL, FR, HL, HR. The lower leg (knee/hock down) of leg k is BONE_LOWER + k. */
export const BONE_FL = 3;
export const BONE_FR = 4;
export const BONE_HL = 5;
export const BONE_HR = 6;
export const BONE_LOWER = 7;
export const BONE_COUNT = 11;
export const BONE_NAMES = [
  "body", "head", "tail", "upperFL", "upperFR", "upperHL", "upperHR", "lowerFL", "lowerFR", "lowerHL", "lowerHR",
] as const;

export type ModelRigType = "quadruped" | "avian" | "serpentine" | "aquatic" | "arachnid" | "flora";

export const AVIAN_BONE_NAMES = ["body", "head", "tail", "wingL", "wingR", "legL", "legR"] as const;
export const SERPENTINE_BONE_NAMES = ["spine0", "spine1", "spine2", "spine3", "tail"] as const;
export const AQUATIC_BONE_NAMES = ["body", "head", "tail", "finL", "finR", "dorsal"] as const;
export const ARACHNID_BONE_NAMES = ["body", "head", "leg1L", "leg1R", "leg2L", "leg2R", "leg3L", "leg3R", "leg4L", "leg4R"] as const;
export const FLORA_BONE_NAMES = ["root", "trunk", "branchL", "branchR", "canopy"] as const;

export interface Frame {
  /** Rotation about +Y (radians) that turns the mesh to face +Z. */
  yaw: number;
  /** Translation applied after the rotation. */
  dx: number;
  dy: number;
  dz: number;
}

export interface Segmentation {
  type?: ModelRigType;
  boneNames?: readonly string[];
  parentIndices?: readonly number[];
  frame: Frame;
  /** Size in the normalised frame. */
  length: number;
  height: number;
  width: number;
  /** Hip height: the leg length. */
  legLength: number;
  /** Knee (hock) height above the ground; the upper leg is legLength - kneeHeight long. */
  kneeHeight: number;
  /** Bone pivots in the normalised frame, indexed by BONE_*. */
  pivots: Array<[number, number, number]>;
  /** Four bone indices and weights per vertex, in the mesh's own vertex order. */
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
}

export interface SegmentHints {
  /** Fraction of the height where the legs end (the belly); found from the shape when absent. */
  legTop?: number;
  /** Knee height as a fraction of the hip height (found from the narrowest leg slice, else 0.5). */
  knee?: number;
  /** +1 / -1 forces which end of the spine is the head, in the normalised frame's input order. */
  headSign?: 1 | -1;
  /** Force a procedural rig type. */
  rigType?: ModelRigType;
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

/** Knee height as a fraction of the hip height: the narrowest leg slice in the middle band, else halfway. */
function findKnee(pts: Float32Array, n: number, legTop: number, W: number): number {
  const slices = 10, lo = 0.35, hi = 0.65;
  const x0 = new Float32Array(slices * 4).fill(Infinity), x1 = new Float32Array(slices * 4).fill(-Infinity);
  const z0 = new Float32Array(slices * 4).fill(Infinity), z1 = new Float32Array(slices * 4).fill(-Infinity);
  const cnt = new Uint16Array(slices * 4);
  for (let i = 0; i < n; i++) {
    const f = pts[i * 3 + 1] / legTop;
    if (f < lo || f >= hi || Math.abs(pts[i * 3]) < 0.1 * W) continue;
    const s = Math.floor(((f - lo) / (hi - lo)) * slices);
    const q = (pts[i * 3] > 0 ? 0 : 1) + (pts[i * 3 + 2] > 0 ? 0 : 2);
    const k = s * 4 + q;
    cnt[k]++;
    x0[k] = Math.min(x0[k], pts[i * 3]);
    x1[k] = Math.max(x1[k], pts[i * 3]);
    z0[k] = Math.min(z0[k], pts[i * 3 + 2]);
    z1[k] = Math.max(z1[k], pts[i * 3 + 2]);
  }
  let best = -1, bestArea = Infinity;
  for (let s = 0; s < slices; s++) {
    let area = 0, legs = 0;
    for (let q = 0; q < 4; q++) {
      const k = s * 4 + q;
      if (cnt[k] < 3) continue;
      area += (x1[k] - x0[k]) * (z1[k] - z0[k]);
      legs++;
    }
    if (legs >= 3 && area < bestArea) { bestArea = area; best = s; }
  }
  // Clamp: a noisy slice must not put the knee near the hip or the foot.
  return best < 0 ? 0.5 : Math.min(0.58, Math.max(0.42, lo + ((best + 0.5) / slices) * (hi - lo)));
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
  const kneeY = (hints.knee ?? findKnee(pts, n, legTop, W)) * legTop;
  const zMid = (zMin + zMax) / 2;
  const zNeck = zMax - 0.3 * L;
  const zRoot = zMin + 0.16 * L;
  // Knee blend: below the knee the lower leg bone, above the upper; wide enough to bend smoothly.
  const kb = 0.14 * legTop;

  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  // Weighted centroids of each leg's own vertices give the hip pivots (the knee sits under the hip).
  const hipSum = [0, 1, 2, 3].map(() => ({ w: 0, x: 0, z: 0 }));
  let headY = 0, headW = 0, tailY = 0, tailW = 0;
  const cand = new Float32Array(BONE_COUNT);
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
    const ax = Math.abs(x);
    const lateral = smooth(0.1 * W, 0.22 * W, ax); // 0 on the centreline (belly, tail), 1 out at a leg
    const legW = (1 - smooth(legTop * 0.6, legTop * 1.2, y)) * lateral;
    const front = smooth(zMid - 0.06 * L, zMid + 0.06 * L, z);
    const left = smooth(-0.08 * W, 0.08 * W, x);
    const lowerF = 1 - smooth(kneeY - kb, kneeY + kb, y);
    const q = [legW * front * left, legW * front * (1 - left), legW * (1 - front) * left, legW * (1 - front) * (1 - left)];
    for (let k = 0; k < 4; k++) {
      cand[BONE_FL + k] = q[k] * (1 - lowerF);
      cand[BONE_LOWER + k] = q[k] * lowerF;
    }
    const room = 1 - legW;
    cand[BONE_HEAD] = room * smooth(zNeck - 0.05 * L, zNeck + 0.08 * L, z) * smooth(legTop * 0.9, legTop * 1.3, y);
    cand[BONE_TAIL] = room * (1 - smooth(zMin + 0.1 * L, zMin + 0.22 * L, z)) * (1 - lateral) * smooth(0.35 * legTop, 0.6 * legTop, y);
    let sum = 0;
    for (let b = 1; b < BONE_COUNT; b++) sum += cand[b];
    cand[BONE_BODY] = Math.max(0, 1 - sum);
    // Top four influences, normalised.
    let w4 = 0;
    for (let k = 0; k < 4; k++) {
      let best = -1, bw = 0;
      for (let b = 0; b < BONE_COUNT; b++) if (cand[b] > bw) { bw = cand[b]; best = b; }
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
    // Pivot statistics from vertices that belong clearly to a part (a lower leg counts for its leg's hip too).
    for (let k = 0; k < 4; k++) {
      const b = skinIndex[i * 4 + k], w = skinWeight[i * 4 + k];
      if (b >= BONE_FL && b < BONE_FL + 4 && w > 0.8) {
        const s = hipSum[b - BONE_FL];
        s.w += 1; s.x += x; s.z += z;
      } else if (b >= BONE_LOWER && w > 0.8) {
        const s = hipSum[b - BONE_LOWER];
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
    const s = hipSum[k];
    const hip: [number, number, number] = s.w > 0 ? [s.x / s.w, legTop, s.z / s.w] : [quad[k][0], legTop, quad[k][1]];
    pivots[BONE_FL + k] = hip;
    pivots[BONE_LOWER + k] = [hip[0], kneeY, hip[2]];
  }
  return {
    type: "quadruped",
    boneNames: BONE_NAMES,
    parentIndices: [-1, 0, 0, 0, 0, 0, 0, 3, 4, 5, 6],
    frame,
    length: L,
    height: H,
    width: W,
    legLength: legTop,
    kneeHeight: kneeY,
    pivots,
    skinIndex,
    skinWeight,
  };
}

/** Classify a model into a procedural rig type using name patterns or geometric proportions. */
export function classifyModelType(positions: ArrayLike<number>, hints?: SegmentHints, modelName?: string): ModelRigType {
  if (hints?.rigType) return hints.rigType;
  if (modelName) {
    const name = modelName.toLowerCase();
    if (/snake|eel|worm|serpent|constrictor/.test(name)) return "serpentine";
    if (/spider|centipede|crab|scorpion|ant|beetle|lobster|ladybug/.test(name)) return "arachnid";
    if (/fish|shark|whale|dolphin|orca|trout|piranha|seahorse|walrus|seal|narwhal|squid|octopus|jellyfish/.test(name)) return "aquatic";
    if (/bird|owl|hawk|eagle|crow|raven|duck|hen|rooster|goose|pelican|seagull|chick|falcon|bat|dragonfly|butterfly|pheasant|quail/.test(name)) return "avian";
    if (/wolf|bear|deer|boar|cow|horse|sheep|goat|pig|coyote|fox|badger|raccoon|cat|dog|lion|tiger|elk|bull|donkey|llama/.test(name)) return "quadruped";
    if (/tree|\bbush\b|plant|flower|grass|kelp|coral|mushroom|fern|anemone|sponge/.test(name)) return "flora";
  }

  // Geometric classification
  const n = Math.floor(positions.length / 3);
  if (n < 12) return "quadruped";
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const L = Math.max(x1 - x0, z1 - z0);
  const W = Math.min(x1 - x0, z1 - z0);
  const H = y1 - y0;

  if (H > 1.8 * L && W < 0.6 * H) return "flora";
  if (L > 2.8 * Math.max(H, W)) return "serpentine";
  if (W > 1.3 * L && H < W * 0.9) return "avian";
  if (H < 0.5 * Math.max(L, W) && W > 0.7 * L) return "arachnid";
  return "quadruped";
}

/** Segment an avian/bird mesh into body, head, tail, wings, and legs. */
export function segmentAvian(positions: ArrayLike<number>, hints: SegmentHints = {}): Segmentation | null {
  const frame = findFrame(positions, hints);
  if (!frame) return null;
  const n = Math.floor(positions.length / 3);
  const pts = new Float32Array(n * 3);
  const tmp: [number, number, number] = [0, 0, 0];
  let xMin = Infinity, xMax = -Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < n; i++) {
    toFrame(positions, i, frame, tmp);
    pts[i * 3] = tmp[0]; pts[i * 3 + 1] = tmp[1]; pts[i * 3 + 2] = tmp[2];
    if (tmp[0] < xMin) xMin = tmp[0]; if (tmp[0] > xMax) xMax = tmp[0];
    if (tmp[1] > yMax) yMax = tmp[1];
    if (tmp[2] < zMin) zMin = tmp[2]; if (tmp[2] > zMax) zMax = tmp[2];
  }
  const L = Math.max(zMax - zMin, 1e-4), H = Math.max(yMax, 1e-4), W = Math.max(xMax - xMin, 1e-4);
  const zMid = (zMin + zMax) / 2;
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const cand = new Float32Array(7);

  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
    const ax = Math.abs(x);
    const headW = smooth(zMid + 0.1 * L, zMax, z) * smooth(0.3 * H, 0.7 * H, y);
    const tailW = (1 - smooth(zMin, zMid - 0.15 * L, z)) * (1 - smooth(0.15 * W, 0.4 * W, ax));
    const wingW = smooth(0.2 * W, 0.45 * W, ax) * smooth(0.3 * H, 0.8 * H, y);
    const legW = (1 - smooth(0.1 * H, 0.35 * H, y)) * smooth(0.08 * W, 0.25 * W, ax);

    cand[0] = Math.max(0.05, 1 - (headW + tailW + wingW + legW)); // body
    cand[1] = headW; // head
    cand[2] = tailW; // tail
    cand[3] = x > 0 ? wingW : 0; // wingL
    cand[4] = x < 0 ? wingW : 0; // wingR
    cand[5] = x > 0 ? legW : 0; // legL
    cand[6] = x < 0 ? legW : 0; // legR

    let sum = 0;
    for (let k = 0; k < 7; k++) sum += cand[k];
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
      skinIndex[i * 4] = 0;
      skinWeight[i * 4] = 1;
    } else for (let k = 0; k < 4; k++) skinWeight[i * 4 + k] /= w4;
  }

  const pivots: Array<[number, number, number]> = [
    [0, 0.4 * H, zMid],
    [0, 0.75 * H, zMax - 0.15 * L],
    [0, 0.45 * H, zMin + 0.1 * L],
    [0.35 * W, 0.5 * H, zMid],
    [-0.35 * W, 0.5 * H, zMid],
    [0.15 * W, 0.25 * H, zMid - 0.05 * L],
    [-0.15 * W, 0.25 * H, zMid - 0.05 * L],
  ];

  return {
    type: "avian",
    boneNames: AVIAN_BONE_NAMES,
    parentIndices: [-1, 0, 0, 0, 0, 0, 0],
    frame, length: L, height: H, width: W, legLength: 0.25 * H, kneeHeight: 0.12 * H,
    pivots, skinIndex, skinWeight,
  };
}

/** Segment a serpentine/snake/eel mesh into 5 sequential spine vertebrae. */
export function segmentSerpentine(positions: ArrayLike<number>, hints: SegmentHints = {}): Segmentation | null {
  const frame = findFrame(positions, hints);
  if (!frame) return null;
  const n = Math.floor(positions.length / 3);
  const pts = new Float32Array(n * 3);
  const tmp: [number, number, number] = [0, 0, 0];
  let xMin = Infinity, xMax = -Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < n; i++) {
    toFrame(positions, i, frame, tmp);
    pts[i * 3] = tmp[0]; pts[i * 3 + 1] = tmp[1]; pts[i * 3 + 2] = tmp[2];
    if (tmp[0] < xMin) xMin = tmp[0]; if (tmp[0] > xMax) xMax = tmp[0];
    if (tmp[1] > yMax) yMax = tmp[1];
    if (tmp[2] < zMin) zMin = tmp[2]; if (tmp[2] > zMax) zMax = tmp[2];
  }
  const L = Math.max(zMax - zMin, 1e-4), H = Math.max(yMax, 1e-4), W = Math.max(xMax - xMin, 1e-4);
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);

  for (let i = 0; i < n; i++) {
    const z = pts[i * 3 + 2];
    // Fraction from head (+z = 1) to tail (-z = 0)
    const u = Math.min(1, Math.max(0, (z - zMin) / L));
    // 5 segments: spine0 (u: 0.8..1), spine1 (u: 0.6..0.8), spine2 (0.4..0.6), spine3 (0.2..0.4), tail (0..0.2)
    const pos = (1 - u) * 4; // 0 at head (spine0), 4 at tail (tail)
    const b0 = Math.min(4, Math.floor(pos));
    const b1 = Math.min(4, b0 + 1);
    const frac = pos - b0;

    skinIndex[i * 4] = b0;
    skinWeight[i * 4] = 1 - frac;
    skinIndex[i * 4 + 1] = b1;
    skinWeight[i * 4 + 1] = frac;
    skinIndex[i * 4 + 2] = 0;
    skinWeight[i * 4 + 2] = 0;
    skinIndex[i * 4 + 3] = 0;
    skinWeight[i * 4 + 3] = 0;
  }

  const pivots: Array<[number, number, number]> = [
    [0, 0.2 * H, zMax - 0.1 * L],
    [0, 0.2 * H, zMax - 0.3 * L],
    [0, 0.2 * H, zMax - 0.5 * L],
    [0, 0.2 * H, zMax - 0.7 * L],
    [0, 0.2 * H, zMin + 0.1 * L],
  ];

  return {
    type: "serpentine",
    boneNames: SERPENTINE_BONE_NAMES,
    parentIndices: [-1, 0, 1, 2, 3],
    frame, length: L, height: H, width: W, legLength: 0.1 * H, kneeHeight: 0.05 * H,
    pivots, skinIndex, skinWeight,
  };
}

/** Segment an aquatic/fish/shark mesh into body, head, caudal tail, pectoral fins, and dorsal fin. */
export function segmentAquatic(positions: ArrayLike<number>, hints: SegmentHints = {}): Segmentation | null {
  const frame = findFrame(positions, hints);
  if (!frame) return null;
  const n = Math.floor(positions.length / 3);
  const pts = new Float32Array(n * 3);
  const tmp: [number, number, number] = [0, 0, 0];
  let xMin = Infinity, xMax = -Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < n; i++) {
    toFrame(positions, i, frame, tmp);
    pts[i * 3] = tmp[0]; pts[i * 3 + 1] = tmp[1]; pts[i * 3 + 2] = tmp[2];
    if (tmp[0] < xMin) xMin = tmp[0]; if (tmp[0] > xMax) xMax = tmp[0];
    if (tmp[1] > yMax) yMax = tmp[1];
    if (tmp[2] < zMin) zMin = tmp[2]; if (tmp[2] > zMax) zMax = tmp[2];
  }
  const L = Math.max(zMax - zMin, 1e-4), H = Math.max(yMax, 1e-4), W = Math.max(xMax - xMin, 1e-4);
  const zMid = (zMin + zMax) / 2;
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const cand = new Float32Array(6);

  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
    const ax = Math.abs(x);
    const headW = smooth(zMid + 0.15 * L, zMax, z);
    const tailW = 1 - smooth(zMin, zMid - 0.2 * L, z);
    const finW = smooth(0.25 * W, 0.48 * W, ax) * (1 - smooth(0.6 * H, 0.9 * H, y));
    const dorsalW = smooth(0.65 * H, 0.95 * H, y) * (1 - smooth(0.12 * W, 0.3 * W, ax));

    cand[0] = Math.max(0.1, 1 - (headW + tailW + finW + dorsalW)); // body
    cand[1] = headW; // head
    cand[2] = tailW; // tail
    cand[3] = x > 0 ? finW : 0; // finL
    cand[4] = x < 0 ? finW : 0; // finR
    cand[5] = dorsalW; // dorsal

    let w4 = 0;
    for (let k = 0; k < 4; k++) {
      let best = -1, bw = 0;
      for (let b = 0; b < 6; b++) if (cand[b] > bw) { bw = cand[b]; best = b; }
      if (best < 0) break;
      skinIndex[i * 4 + k] = best;
      skinWeight[i * 4 + k] = bw;
      w4 += bw;
      cand[best] = 0;
    }
    if (w4 <= 0) {
      skinIndex[i * 4] = 0;
      skinWeight[i * 4] = 1;
    } else for (let k = 0; k < 4; k++) skinWeight[i * 4 + k] /= w4;
  }

  const pivots: Array<[number, number, number]> = [
    [0, 0.5 * H, zMid],
    [0, 0.5 * H, zMax - 0.15 * L],
    [0, 0.5 * H, zMin + 0.1 * L],
    [0.3 * W, 0.4 * H, zMid + 0.1 * L],
    [-0.3 * W, 0.4 * H, zMid + 0.1 * L],
    [0, 0.85 * H, zMid],
  ];

  return {
    type: "aquatic",
    boneNames: AQUATIC_BONE_NAMES,
    parentIndices: [-1, 0, 0, 0, 0, 0],
    frame, length: L, height: H, width: W, legLength: 0.2 * H, kneeHeight: 0.1 * H,
    pivots, skinIndex, skinWeight,
  };
}

/** Segment an arachnid/spider/crab mesh into cephalothorax, abdomen, and 4 leg pairs. */
export function segmentArachnid(positions: ArrayLike<number>, hints: SegmentHints = {}): Segmentation | null {
  const frame = findFrame(positions, hints);
  if (!frame) return null;
  const n = Math.floor(positions.length / 3);
  const pts = new Float32Array(n * 3);
  const tmp: [number, number, number] = [0, 0, 0];
  let xMin = Infinity, xMax = -Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < n; i++) {
    toFrame(positions, i, frame, tmp);
    pts[i * 3] = tmp[0]; pts[i * 3 + 1] = tmp[1]; pts[i * 3 + 2] = tmp[2];
    if (tmp[0] < xMin) xMin = tmp[0]; if (tmp[0] > xMax) xMax = tmp[0];
    if (tmp[1] > yMax) yMax = tmp[1];
    if (tmp[2] < zMin) zMin = tmp[2]; if (tmp[2] > zMax) zMax = tmp[2];
  }
  const L = Math.max(zMax - zMin, 1e-4), H = Math.max(yMax, 1e-4), W = Math.max(xMax - xMin, 1e-4);
  const zMid = (zMin + zMax) / 2;
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const cand = new Float32Array(10);

  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], z = pts[i * 3 + 2];
    const ax = Math.abs(x);
    const isLeg = smooth(0.18 * W, 0.38 * W, ax);
    const headW = (1 - isLeg) * smooth(zMid + 0.1 * L, zMax, z);
    const bodyW = (1 - isLeg) * (1 - headW);

    cand[0] = bodyW; // body / abdomen
    cand[1] = headW; // head / cephalothorax

    // Legs 1..4 along z axis from front to back
    const uZ = Math.min(1, Math.max(0, (z - zMin) / L));
    for (let k = 0; k < 4; k++) {
      const wK = isLeg * Math.max(0, 1 - Math.abs((1 - uZ) * 4 - (k + 0.5)) * 1.5);
      cand[2 + k * 2] = x > 0 ? wK : 0; // leg k L
      cand[3 + k * 2] = x < 0 ? wK : 0; // leg k R
    }

    let w4 = 0;
    for (let k = 0; k < 4; k++) {
      let best = -1, bw = 0;
      for (let b = 0; b < 10; b++) if (cand[b] > bw) { bw = cand[b]; best = b; }
      if (best < 0) break;
      skinIndex[i * 4 + k] = best;
      skinWeight[i * 4 + k] = bw;
      w4 += bw;
      cand[best] = 0;
    }
    if (w4 <= 0) {
      skinIndex[i * 4] = 0;
      skinWeight[i * 4] = 1;
    } else for (let k = 0; k < 4; k++) skinWeight[i * 4 + k] /= w4;
  }

  const pivots: Array<[number, number, number]> = [
    [0, 0.35 * H, zMid - 0.1 * L], // body
    [0, 0.4 * H, zMax - 0.15 * L], // head
    // 4 leg pairs radiating outward
    [0.25 * W, 0.3 * H, zMax - 0.2 * L], [-0.25 * W, 0.3 * H, zMax - 0.2 * L],
    [0.32 * W, 0.3 * H, zMid + 0.1 * L], [-0.32 * W, 0.3 * H, zMid + 0.1 * L],
    [0.32 * W, 0.3 * H, zMid - 0.1 * L], [-0.32 * W, 0.3 * H, zMid - 0.1 * L],
    [0.25 * W, 0.3 * H, zMin + 0.2 * L], [-0.25 * W, 0.3 * H, zMin + 0.2 * L],
  ];

  return {
    type: "arachnid",
    boneNames: ARACHNID_BONE_NAMES,
    parentIndices: [-1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    frame, length: L, height: H, width: W, legLength: 0.35 * H, kneeHeight: 0.2 * H,
    pivots, skinIndex, skinWeight,
  };
}

/** Segment a flora/tree/bush mesh into root, trunk, branches, and canopy. */
export function segmentFlora(positions: ArrayLike<number>, _hints: SegmentHints = {}): Segmentation | null {
  const n = Math.floor(positions.length / 3);
  if (n < 12) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const frame: Frame = { yaw: 0, dx: -(x0 + x1) / 2, dy: -y0, dz: -(z0 + z1) / 2 };
  const L = Math.max(z1 - z0, 1e-4), H = Math.max(y1 - y0, 1e-4), W = Math.max(x1 - x0, 1e-4);
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const cand = new Float32Array(5);

  for (let i = 0; i < n; i++) {
    const x = positions[i * 3] + frame.dx;
    const y = positions[i * 3 + 1] + frame.dy;
    const ax = Math.abs(x);
    const uY = Math.min(1, Math.max(0, y / H));

    const rootW = 1 - smooth(0.05, 0.25, uY);
    const canopyW = smooth(0.65, 0.95, uY);
    const branchW = smooth(0.4, 0.75, uY) * smooth(0.2 * W, 0.45 * W, ax);
    const trunkW = (1 - (rootW + canopyW + branchW));

    cand[0] = rootW;
    cand[1] = Math.max(0, trunkW);
    cand[2] = x > 0 ? branchW : 0;
    cand[3] = x < 0 ? branchW : 0;
    cand[4] = canopyW;

    let w4 = 0;
    for (let k = 0; k < 4; k++) {
      let best = -1, bw = 0;
      for (let b = 0; b < 5; b++) if (cand[b] > bw) { bw = cand[b]; best = b; }
      if (best < 0) break;
      skinIndex[i * 4 + k] = best;
      skinWeight[i * 4 + k] = bw;
      w4 += bw;
      cand[best] = 0;
    }
    if (w4 <= 0) {
      skinIndex[i * 4] = 0;
      skinWeight[i * 4] = 1;
    } else for (let k = 0; k < 4; k++) skinWeight[i * 4 + k] /= w4;
  }

  const pivots: Array<[number, number, number]> = [
    [0, 0, 0],
    [0, 0.35 * H, 0],
    [0.25 * W, 0.65 * H, 0],
    [-0.25 * W, 0.65 * H, 0],
    [0, 0.85 * H, 0],
  ];

  return {
    type: "flora",
    boneNames: FLORA_BONE_NAMES,
    parentIndices: [-1, 0, 1, 1, 1],
    frame, length: L, height: H, width: W, legLength: 0.35 * H, kneeHeight: 0.15 * H,
    pivots, skinIndex, skinWeight,
  };
}

/**
 * Universal segmentation solver: classifies the model and generates procedural bones and skin weights.
 */
export function segmentModel(positions: ArrayLike<number>, hints: SegmentHints = {}, modelName?: string): Segmentation | null {
  const targetType = classifyModelType(positions, hints, modelName);
  if (targetType === "quadruped") {
    const quad = segmentQuadruped(positions, hints);
    if (quad) return quad;
  }
  if (targetType === "avian") {
    const avian = segmentAvian(positions, hints);
    if (avian) return avian;
  }
  if (targetType === "serpentine") {
    const snake = segmentSerpentine(positions, hints);
    if (snake) return snake;
  }
  if (targetType === "aquatic") {
    const fish = segmentAquatic(positions, hints);
    if (fish) return fish;
  }
  if (targetType === "arachnid") {
    const spider = segmentArachnid(positions, hints);
    if (spider) return spider;
  }
  if (targetType === "flora") {
    const plant = segmentFlora(positions, hints);
    if (plant) return plant;
  }
  // Fallback cascade
  return segmentAvian(positions, hints) ??
         segmentSerpentine(positions, hints) ??
         segmentAquatic(positions, hints) ??
         segmentArachnid(positions, hints) ??
         segmentFlora(positions, hints);
}
