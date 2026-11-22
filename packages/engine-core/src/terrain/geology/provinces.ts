/**
 * Geology snapshot -> per-cell fields on the survey grid: which plate, which
 * province (kind + connected patch), distance to the nearest plate boundary,
 * and the macro uplift (metres) the survey adds in place of `rangeUplift`.
 *
 * Classification (per cell, at the warped position):
 *  - nearest plate = the Voronoi site; the exact distance to its cell edge is
 *    min_j (|p−c_j|² − |p−c_a|²) / (2|c_j−c_a|), which also names the neighbour;
 *  - the relative velocity across that edge, along its normal, decides the
 *    boundary: converging → collision belt (continent–continent: orogen, with
 *    a foreland basin on the down-going side) or volcanic arc (ocean under
 *    continent); diverging → rift (with uplifted shoulders); neither → transform;
 *  - interiors are platform, or ocean on an oceanic plate; cratons (explicit
 *    ellipses) are stable and win over every belt but ocean; old sutures leave
 *    worn ridges across platform and foreland.
 * Provinces are the 4-connected patches of equal (kind, plate); patches under
 * `minProvinceArea` merge into their largest neighbour. Designer overrides
 * retag the patch containing a point.
 *
 * Arithmetic is + − × ÷ and sqrt only, so the fields are bit-identical on
 * every CPU given the same warp noise (strict-IEEE procgen addon).
 */

import { createHash } from "node:crypto";
import { boxBlur } from "../grid-ops.js";
import { kindCode, PROVINCE_KINDS, type GeologySpec, type ProvinceKind } from "./snapshot.js";

export interface GeoGrid {
  width: number;
  depth: number;
  cell: number;
  originX: number;
  originZ: number;
}

/** Normalised noise (-1..1) per grid cell for (salt, feature size in metres). */
export type NoiseFn = (salt: number, scaleM: number) => Float32Array;

export interface ProvinceRecord {
  /** Stable within one snapshot: "G01", "G02", … in scan order. */
  id: string;
  kind: ProvinceKind;
  plate: number;
  cells: number;
  areaM2: number;
  /** Centroid and bounds, world metres. */
  x: number;
  z: number;
  bbox: [number, number, number, number];
}

export interface GeologyFields {
  plate: Uint8Array;
  /** Province kind code per cell (index into PROVINCE_KINDS). */
  kind: Uint8Array;
  /** Province index per cell (into `provinces`). */
  province: Uint16Array;
  /** Distance to the nearest plate boundary, metres. */
  boundaryM: Float32Array;
  /** Macro uplift, metres. */
  uplift: Float32Array;
  provinces: ProvinceRecord[];
  /** sha256 (16 hex) of kind, province and uplift bytes. */
  hash: string;
}

const bell = (t: number): number => {
  if (t >= 1) return 0;
  const a = 1 - t * t;
  return a * a;
};
/** 0 at s = 0 and 1, peak 1 at 0.5. */
const bump = (s: number): number => (s <= 0 || s >= 1 ? 0 : bell(Math.abs(2 * s - 1)));
const smooth01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - (ax + t * dx);
  const ez = pz - (az + t * dz);
  return Math.sqrt(ex * ex + ez * ez);
}

const OCEAN = kindCode("ocean");
const PLATFORM = kindCode("platform");
const CRATON = kindCode("craton");
const OROGEN = kindCode("orogen");
const FORELAND = kindCode("foreland");
const RIFT = kindCode("rift");
const ARC = kindCode("arc");
const SUTURE = kindCode("suture");
const TRANSFORM = kindCode("transform");

/** 4-connected patches of equal key. Returns label per cell and patch sizes. */
function patches(key: Uint16Array, W: number, D: number): { label: Int32Array; sizes: number[]; keys: number[] } {
  const label = new Int32Array(W * D).fill(-1);
  const sizes: number[] = [];
  const keys: number[] = [];
  const stack = new Int32Array(W * D);
  for (let s = 0; s < W * D; s++) {
    if (label[s] !== -1) continue;
    const id = sizes.length;
    const k = key[s];
    let top = 0;
    let size = 0;
    stack[top++] = s;
    label[s] = id;
    while (top > 0) {
      const i = stack[--top];
      size++;
      const u = i % W;
      if (u > 0 && label[i - 1] === -1 && key[i - 1] === k) { label[i - 1] = id; stack[top++] = i - 1; }
      if (u < W - 1 && label[i + 1] === -1 && key[i + 1] === k) { label[i + 1] = id; stack[top++] = i + 1; }
      if (i >= W && label[i - W] === -1 && key[i - W] === k) { label[i - W] = id; stack[top++] = i - W; }
      if (i + W < W * D && label[i + W] === -1 && key[i + W] === k) { label[i + W] = id; stack[top++] = i + W; }
    }
    sizes.push(size);
    keys.push(k);
  }
  return { label, sizes, keys };
}

export function classifyGeology(geo: GeologySpec, grid: GeoGrid, noise: NoiseFn): GeologyFields {
  const W = grid.width;
  const D = grid.depth;
  const N = W * D;
  const Wd = geo.widths;
  const R = geo.relief;
  const plates = geo.plates;
  const P = plates.length;

  const warpX = Wd.warpM > 0 ? noise(1, Wd.warpScaleM) : new Float32Array(N);
  const warpZ = Wd.warpM > 0 ? noise(2, Wd.warpScaleM) : new Float32Array(N);
  const strikeN = noise(3, R.strikeScaleM);
  const ridgeN = noise(4, R.ridgeScaleM);

  // Pairwise geometry: |c_j − c_a| and the unit normal a→j.
  const sep = new Float64Array(P * P);
  for (let a = 0; a < P; a++) {
    for (let j = 0; j < P; j++) {
      const dx = plates[j].x - plates[a].x;
      const dz = plates[j].z - plates[a].z;
      sep[a * P + j] = Math.sqrt(dx * dx + dz * dz);
    }
  }

  const plate = new Uint8Array(N);
  const kind = new Uint8Array(N);
  const boundaryM = new Float32Array(N);
  const uplift = new Float32Array(N);
  const orogenHalf = Wd.orogenM / 2;
  const riftHalf = Wd.riftM / 2;
  const sutureHalf = Wd.sutureM / 2;
  const transformHalf = Wd.transformM / 2;

  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      const x0 = grid.originX + u * grid.cell;
      const z0 = grid.originZ + v * grid.cell;
      const x = x0 + Wd.warpM * warpX[i];
      const z = z0 + Wd.warpM * warpZ[i];

      let a = 0;
      let best = Infinity;
      for (let p = 0; p < P; p++) {
        const dx = x - plates[p].x;
        const dz = z - plates[p].z;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) { best = d2; a = p; }
      }
      let b = -1;
      let dEdge = Infinity;
      for (let j = 0; j < P; j++) {
        if (j === a || sep[a * P + j] === 0) continue;
        const dx = x - plates[j].x;
        const dz = z - plates[j].z;
        const d = (dx * dx + dz * dz - best) / (2 * sep[a * P + j]);
        if (d < dEdge) { dEdge = d; b = j; }
      }
      plate[i] = plates[a].id;
      boundaryM[i] = dEdge;

      const pa = plates[a];
      const strikeMod = 1 - R.strike * (1 - strikeN[i]) * 0.5;
      const ridgeMod = 1 - R.ridges + R.ridges * (1 - Math.abs(ridgeN[i]));
      let k = pa.kind === "oceanic" ? OCEAN : PLATFORM;
      let up = pa.kind === "oceanic" ? R.oceanM * smooth01(dEdge / Wd.arcM) : 0;

      if (b >= 0) {
        const pb = plates[b];
        const s = sep[a * P + b];
        const nx = (pb.x - pa.x) / s;
        const nz = (pb.z - pa.z) / s;
        const vn = (pb.vx - pa.vx) * nx + (pb.vz - pa.vz) * nz;
        if (Math.abs(vn) < Wd.transformBelowCmYr) {
          if (dEdge < transformHalf && pa.kind === "continental") {
            k = TRANSFORM;
            up = R.transformM * bell(dEdge / transformHalf);
          }
        } else if (vn < 0) {
          if (pa.kind === "continental" && pb.kind === "continental") {
            if (dEdge < orogenHalf) {
              k = OROGEN;
              up = R.orogenM * bell(dEdge / orogenHalf) * strikeMod * ridgeMod;
            } else {
              // a is down-going when it closes on the edge at least as fast as b.
              const aIn = pa.vx * nx + pa.vz * nz;
              const bIn = -(pb.vx * nx + pb.vz * nz);
              if (aIn >= bIn && dEdge < orogenHalf + Wd.forelandM) {
                k = FORELAND;
                up = R.forelandM * bump((dEdge - orogenHalf) / Wd.forelandM);
              }
            }
          } else if (pa.kind === "continental" && dEdge < Wd.arcM) {
            k = ARC;
            up = R.arcM * bell(dEdge / Wd.arcM) * strikeMod * ridgeMod;
          }
        } else if (pa.kind === "continental" && pb.kind === "continental") {
          if (dEdge < riftHalf) {
            k = RIFT;
            up = R.riftM * bell(dEdge / riftHalf);
          } else if (dEdge < 2 * riftHalf) {
            up = R.riftShoulderM * bump((dEdge - riftHalf) / riftHalf);
          }
        }
      }

      if (k !== OCEAN) {
        // Old sutures: worn ridges across platform, foreland and transforms.
        if (k === PLATFORM || k === FORELAND || k === TRANSFORM) {
          let ds = Infinity;
          for (const su of geo.sutures) {
            for (let s = 1; s < su.points.length; s++) {
              const p0 = su.points[s - 1];
              const p1 = su.points[s];
              ds = Math.min(ds, segmentDistance(x, z, p0.x, p0.z, p1.x, p1.z));
            }
          }
          if (ds < sutureHalf) {
            k = SUTURE;
            up = R.sutureM * bell(ds / sutureHalf) * ridgeMod;
          }
        }
        // Cratons: stable cores; a plateau that wins over every belt.
        for (const c of geo.cratons) {
          const al = Math.sqrt(c.ax * c.ax + c.az * c.az) || 1;
          const ax = c.ax / al;
          const az = c.az / al;
          const dx = x - c.x;
          const dz = z - c.z;
          const along = (dx * ax + dz * az) / c.rx;
          const across = (-dx * az + dz * ax) / c.rz;
          const e = Math.sqrt(along * along + across * across);
          if (e < 1) {
            const rim = (1 - e) * (c.rx < c.rz ? c.rx : c.rz);
            const plateau = smooth01(rim / Wd.cratonRimM);
            k = CRATON;
            up = up * (1 - plateau) + R.cratonM * plateau;
            break;
          }
        }
      }
      kind[i] = k;
      uplift[i] = up;
    }
  }

  // Provinces: patches of (kind, plate), small ones merged, then overrides.
  const key = new Uint16Array(N);
  for (let i = 0; i < N; i++) key[i] = kind[i] * 256 + plate[i];
  const minCells = geo.minProvinceArea / (grid.cell * grid.cell);
  for (let pass = 0; pass < 3; pass++) {
    const { label, sizes, keys } = patches(key, W, D);
    let merged = 0;
    // Each small patch takes the key of the neighbour patch it borders most.
    const border = new Map<number, Map<number, number>>();
    for (let i = 0; i < N; i++) {
      const l = label[i];
      if (sizes[l] >= minCells) continue;
      const u = i % W;
      const nbs = [u > 0 ? i - 1 : -1, u < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i + W < N ? i + W : -1];
      for (const j of nbs) {
        if (j < 0 || label[j] === l) continue;
        let m = border.get(l);
        if (!m) border.set(l, (m = new Map()));
        m.set(label[j], (m.get(label[j]) ?? 0) + 1);
      }
    }
    const target = new Map<number, number>();
    for (const [l, m] of border) {
      let bestL = -1;
      let bestScore = -1;
      for (const [nl, count] of m) {
        // Most shared border; ties -> larger neighbour, then lower label.
        const score = count * 1e7 + sizes[nl];
        if (score > bestScore || (score === bestScore && nl < bestL)) { bestScore = score; bestL = nl; }
      }
      if (bestL >= 0) target.set(l, keys[bestL]);
    }
    for (let i = 0; i < N; i++) {
      const t = target.get(label[i]);
      if (t !== undefined) { key[i] = t; merged++; }
    }
    if (merged === 0) break;
  }
  for (const o of geo.overrides) {
    const u = Math.round((o.at.x - grid.originX) / grid.cell);
    const v = Math.round((o.at.z - grid.originZ) / grid.cell);
    if (u < 0 || v < 0 || u >= W || v >= D) continue;
    const { label } = patches(key, W, D);
    const l = label[v * W + u];
    const nk = kindCode(o.kind) * 256 + (key[v * W + u] & 255);
    for (let i = 0; i < N; i++) if (label[i] === l) key[i] = nk;
  }
  // Kinds follow the final keys (merges and overrides retag cells). Uplift is
  // recomputed only where an override changed the kind: a retagged patch gets
  // its new kind's interior relief, faded in from its edge.
  const { label, sizes } = patches(key, W, D);
  const retag = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const k = key[i] >> 8;
    if (k !== kind[i] && geo.overrides.length > 0) retag[i] = 1;
    kind[i] = k;
  }
  if (geo.overrides.length > 0) applyOverrideRelief(geo, grid, kind, retag, uplift, strikeN, ridgeN);

  const province = new Uint16Array(N);
  const provinces: ProvinceRecord[] = [];
  const sum = sizes.map(() => ({ x: 0, z: 0, minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity }));
  for (let i = 0; i < N; i++) {
    const l = label[i];
    province[i] = l;
    const u = i % W;
    const v = (i - u) / W;
    const x = grid.originX + u * grid.cell;
    const z = grid.originZ + v * grid.cell;
    const s = sum[l];
    s.x += x;
    s.z += z;
    if (x < s.minX) s.minX = x;
    if (z < s.minZ) s.minZ = z;
    if (x > s.maxX) s.maxX = x;
    if (z > s.maxZ) s.maxZ = z;
  }
  const firstCell = new Int32Array(sizes.length).fill(-1);
  for (let i = 0; i < N; i++) if (firstCell[label[i]] < 0) firstCell[label[i]] = i;
  for (let l = 0; l < sizes.length; l++) {
    const s = sum[l];
    provinces.push({
      id: `G${String(l + 1).padStart(2, "0")}`,
      kind: PROVINCE_KINDS[key[firstCell[l]] >> 8],
      plate: key[firstCell[l]] & 255,
      cells: sizes[l],
      areaM2: sizes[l] * grid.cell * grid.cell,
      x: Math.round(s.x / sizes[l]),
      z: Math.round(s.z / sizes[l]),
      bbox: [s.minX, s.minZ, s.maxX, s.maxZ],
    });
  }

  const smoothCells = R.smoothM / grid.cell;
  const finalUplift = smoothCells >= 0.5 ? boxBlur(uplift, W, D, smoothCells) : uplift;
  const hash = createHash("sha256")
    .update(kind)
    .update(new Uint8Array(province.buffer))
    .update(new Uint8Array(finalUplift.buffer))
    .digest("hex")
    .slice(0, 16);
  return { plate, kind, province, boundaryM, uplift: finalUplift, provinces, hash };
}

/** Interior relief for an overridden patch, faded in over `cratonRimM` from its edge. */
function applyOverrideRelief(
  geo: GeologySpec,
  grid: GeoGrid,
  kind: Uint8Array,
  retag: Uint8Array,
  uplift: Float32Array,
  strikeN: Float32Array,
  ridgeN: Float32Array,
): void {
  const W = grid.width;
  const D = grid.depth;
  const R = geo.relief;
  const level: Record<number, number> = {
    [OCEAN]: R.oceanM,
    [PLATFORM]: 0,
    [CRATON]: R.cratonM,
    [OROGEN]: R.orogenM * 0.6,
    [FORELAND]: R.forelandM,
    [RIFT]: R.riftM,
    [ARC]: R.arcM * 0.6,
    [SUTURE]: R.sutureM * 0.6,
    [TRANSFORM]: R.transformM,
  };
  // Chamfer distance (cells) from each retagged cell to the patch edge.
  const dist = new Float32Array(W * D);
  for (let i = 0; i < W * D; i++) dist[i] = retag[i] ? 1e9 : 0;
  for (let pass = 0; pass < 2; pass++) {
    const fwd = pass === 0;
    for (let n = 0; n < W * D; n++) {
      const i = fwd ? n : W * D - 1 - n;
      if (!retag[i]) continue;
      const u = i % W;
      const v = (i - u) / W;
      const du = fwd ? -1 : 1;
      const cand = [u + du >= 0 && u + du < W ? dist[i + du] + 1 : 1e9, v - du >= 0 && v - du < D ? dist[i - du * W] + 1 : 1e9];
      dist[i] = Math.min(dist[i], cand[0], cand[1]);
    }
  }
  const rimCells = geo.widths.cratonRimM / grid.cell;
  for (let i = 0; i < W * D; i++) {
    if (!retag[i]) continue;
    const f = smooth01(dist[i] / rimCells);
    const k = kind[i];
    const mod = k === OROGEN || k === ARC ? (1 - R.strike * (1 - strikeN[i]) * 0.5) * (1 - R.ridges + R.ridges * (1 - Math.abs(ridgeN[i]))) : 1;
    uplift[i] = uplift[i] * (1 - f) + level[k] * mod * f;
  }
}
