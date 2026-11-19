/**
 * GLB pivot-relative bounding-box extractor and catalog binder.
 *
 * Unlike symmetric [-size/2 .. +size/2] approximations, GLBs carry their native
 * mesh pivot (e.g. Synty modular walls start at X = 0..2.5 and Y = 0..2.5).
 * Computing exact min/max in mesh pivot space is essential so separated physics
 * colliders and split door jambs align to the rendered GLB vertices to the mm.
 */

import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import type { BoundsData, Vec3Tuple } from "./types.js";

export interface CatalogModelBounds {
  /** Catalog model id, e.g. "fantasy-kingdom/SM_Bld_House_Wall_01". */
  assetRef: string;
  /** Model bare name, e.g. "SM_Bld_House_Wall_01". */
  partId: string;
  /** Pack slug, e.g. "fantasy-kingdom". */
  pack: string;
  /** Asset category folder from catalog.json (e.g. "Buildings", "Props"). */
  catalogCategory: string;
  /** Exact pivot-relative min/max/size bounds in metres. */
  bounds: BoundsData;
}

interface GltfNode {
  matrix?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  mesh?: number;
  children?: number[];
}

interface GltfJson {
  nodes?: GltfNode[];
  meshes?: Array<{ primitives?: Array<{ attributes?: { POSITION?: number } }> }>;
  accessors?: Array<{ min?: [number, number, number]; max?: [number, number, number] }>;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000 + 0;

/**
 * Parse a GLB file's binary header + JSON chunk and return its exact
 * pivot-relative AABB (`min`, `max`, `size`) in metres without full mesh decode.
 */
export function readGlbPivotBounds(glbPath: string): BoundsData | null {
  const buf = fs.readFileSync(glbPath);
  if (buf.byteLength < 20) return null;
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67 /* 'glTF' */) return null;
  const jsonLen = buf.readUInt32LE(12);
  const jsonType = buf.readUInt32LE(16);
  if (jsonType !== 0x4e4f534a /* 'JSON' */ || 20 + jsonLen > buf.byteLength) return null;

  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8")) as GltfJson;
  const nodes = gltf.nodes ?? [];
  const meshes = gltf.meshes ?? [];
  const accessors = gltf.accessors ?? [];

  const childSet = new Set<number>();
  for (const n of nodes) {
    for (const c of n.children ?? []) childSet.add(c);
  }
  const roots = nodes.map((_, i) => i).filter((i) => !childSet.has(i));

  const min: Vec3Tuple = [Infinity, Infinity, Infinity];
  const max: Vec3Tuple = [-Infinity, -Infinity, -Infinity];
  const pt = new THREE.Vector3();

  const nodeMatrix = (n: GltfNode): THREE.Matrix4 => {
    const m = new THREE.Matrix4();
    if (n.matrix && n.matrix.length === 16) {
      m.fromArray(n.matrix);
      return m;
    }
    const t = n.translation ?? [0, 0, 0];
    const r = n.rotation ?? [0, 0, 0, 1];
    const s = n.scale ?? [1, 1, 1];
    return m.compose(
      new THREE.Vector3(t[0], t[1], t[2]),
      new THREE.Quaternion(r[0], r[1], r[2], r[3]),
      new THREE.Vector3(s[0], s[1], s[2]),
    );
  };

  const visit = (idx: number, parentMat: THREE.Matrix4): void => {
    const n = nodes[idx];
    if (!n) return;
    const mat = new THREE.Matrix4().copy(parentMat).multiply(nodeMatrix(n));
    if (n.mesh !== undefined) {
      const mesh = meshes[n.mesh];
      for (const prim of mesh?.primitives ?? []) {
        const accIdx = prim.attributes?.POSITION;
        const acc = accIdx !== undefined ? accessors[accIdx] : undefined;
        if (!acc?.min || !acc?.max) continue;
        for (const dx of [acc.min[0], acc.max[0]]) {
          for (const dy of [acc.min[1], acc.max[1]]) {
            for (const dz of [acc.min[2], acc.max[2]]) {
              pt.set(dx, dy, dz).applyMatrix4(mat);
              if (pt.x < min[0]) min[0] = pt.x;
              if (pt.y < min[1]) min[1] = pt.y;
              if (pt.z < min[2]) min[2] = pt.z;
              if (pt.x > max[0]) max[0] = pt.x;
              if (pt.y > max[1]) max[1] = pt.y;
              if (pt.z > max[2]) max[2] = pt.z;
            }
          }
        }
      }
    }
    for (const c of n.children ?? []) visit(c, mat);
  };

  const ident = new THREE.Matrix4();
  for (const r of roots) visit(r, ident);
  if (!Number.isFinite(min[0])) return null;

  const rMin: Vec3Tuple = [round3(min[0]), round3(min[1]), round3(min[2])];
  const rMax: Vec3Tuple = [round3(max[0]), round3(max[1]), round3(max[2])];
  return {
    min: rMin,
    max: rMax,
    size: [round3(rMax[0] - rMin[0]), round3(rMax[1] - rMin[1]), round3(rMax[2] - rMin[2])],
  };
}

export interface CatalogModelEntry {
  id: string;
  pack: string;
  name: string;
  category: string;
  file: string;
  size: Vec3Tuple;
}

/**
 * Index catalog models for fast assetRef + exact GLB pivot bounds lookup.
 * Filters optionally by pack slug (e.g. "fantasy-kingdom").
 * Reads actual GLBs from `assetsRoot` when available; falls back to catalog `size` centered in XZ and bottom-grounded in Y.
 */
export function loadCatalogPartBounds(
  catalogPath: string,
  opts: { pack?: string; assetsRoot?: string; readGlb?: boolean } = {},
): Map<string, CatalogModelBounds> {
  const raw = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as { models: CatalogModelEntry[] };
  const assetsRoot = opts.assetsRoot ?? path.dirname(catalogPath);
  const readGlb = opts.readGlb ?? true;
  const byPartId = new Map<string, CatalogModelBounds>();

  for (const m of raw.models) {
    if (opts.pack && m.pack !== opts.pack) continue;
    let bounds: BoundsData | null = null;
    if (readGlb && m.file) {
      const glbPath = path.join(assetsRoot, m.file);
      if (fs.existsSync(glbPath)) {
        bounds = readGlbPivotBounds(glbPath);
      }
    }
    if (!bounds) {
      const [sx, sy, sz] = m.size;
      bounds = {
        min: [round3(-sx / 2), 0, round3(-sz / 2)],
        max: [round3(sx / 2), round3(sy), round3(sz / 2)],
        size: [round3(sx), round3(sy), round3(sz)],
      };
    }
    const entry: CatalogModelBounds = {
      assetRef: m.id,
      partId: m.name,
      pack: m.pack,
      catalogCategory: m.category,
      bounds,
    };
    byPartId.set(m.name, entry);
    byPartId.set(m.id, entry);
  }
  return byPartId;
}

/** Return the center offset of a pivot-relative BoundsData. */
export function boundsCenter(bounds: BoundsData): Vec3Tuple {
  return [
    round3((bounds.min[0] + bounds.max[0]) / 2),
    round3((bounds.min[1] + bounds.max[1]) / 2),
    round3((bounds.min[2] + bounds.max[2]) / 2),
  ];
}
