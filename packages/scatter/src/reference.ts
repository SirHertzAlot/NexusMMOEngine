/**
 * Reference evaluator — AUTHORING-TIME ONLY.
 *
 * Executes a CookedPlan for (worldSeed, cx, cz) to validate plans and
 * produce golden vectors. This is cooking/validation tooling: it NEVER
 * runs in the region process or on the tick path. The runtime authority
 * is the C++ scatter addon (PCG slice 3), which must reproduce these
 * semantics bit-for-bit.
 *
 * Determinism contract (portable to C++ — all arithmetic is u32):
 *
 *   hashU32(x): splitmix32-style finalizer —
 *     x = imul(x ^ (x >>> 16), 0x45d9f3b)
 *     x = imul(x ^ (x >>> 16), 0x45d9f3b)
 *     x = (x ^ (x >>> 16)) >>> 0
 *   hash01(x) = hashU32(x) / 4294967296        // [0, 1)
 *   deriveChunkSeed(worldSeed, cx, cz) =
 *     hashU32((worldSeed ^ imul(cx, 374761393) ^ imul(cz, 668265263)) >>> 0)
 *
 * All stochastic choices are per-point hashes (never sequential PRNG
 * streams), so filter compaction cannot change downstream randomness,
 * and point processing order is irrelevant. Points are still sorted by
 * seed (canonical ordering) after sampling, per UE discipline.
 */
import type { CookedPlan } from "./cooker.js";
import {
  attrColumn,
  compactPoints,
  createPointList,
  pushPoint,
  sortBySeedCanonical,
  type PointList,
} from "./points.js";

/** u32 mix — the single hash primitive everything builds on. */
export function hashU32(x: number): number {
  x = x >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

/** Deterministic [0, 1) from a u32. */
export function hash01(x: number): number {
  return hashU32(x) / 4294967296;
}

/**
 * Chunk seed = worldSeed XOR chunk hash, mixed. cx/cz are int32 chunk
 * coords; worldSeed is u32.
 */
export function deriveChunkSeed(
  worldSeed: number,
  cx: number,
  cz: number,
): number {
  const mixed =
    (worldSeed >>> 0) ^
    Math.imul(cx | 0, 374761393) ^
    Math.imul(cz | 0, 668265263);
  return hashU32(mixed >>> 0);
}

/** Chunk footprint in world units (matches addon-procgen CHUNK_SIZE). */
export const SCATTER_CHUNK_SIZE = 16;

export interface EvalContext {
  /** u32 world seed. */
  worldSeed: number;
  /** int32 chunk coords. */
  cx: number;
  cz: number;
  /**
   * Terrain height sampler. In production this is the C++ generateChunk
   * output; in tests any analytic function. Required by slopeFilter.
   */
  heightAt?: (x: number, z: number) => number;
}

export interface SpawnRecord {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  sx: number;
  sy: number;
  sz: number;
  /** Manifest model id (resolved to u32 asset hash by the spawn table). */
  asset: string;
  /** u32 — variant selection seed for the spawner. */
  variantSeed: number;
  /** u32 point seed (stable identity). */
  seed: number;
  attrs: Record<string, number>;
}

type Ctx = EvalContext & { chunkSeed: number };

function evalGridSampler(
  settings: Record<string, unknown>,
  ctx: Ctx,
): PointList {
  const spacing = settings.spacing as number;
  const jitter = settings.jitter as number;
  if (!ctx.heightAt) {
    throw new Error("gridSampler requires ctx.heightAt (chunk heightfield)");
  }
  const heightAt = ctx.heightAt;
  const n = Math.max(1, Math.ceil(SCATTER_CHUNK_SIZE / spacing));
  const pts = createPointList(n * n);
  const ox = ctx.cx * SCATTER_CHUNK_SIZE;
  const oz = ctx.cz * SCATTER_CHUNK_SIZE;
  let lattice = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const pointSeed = hashU32(
        (ctx.chunkSeed ^ hashU32(lattice)) >>> 0,
      );
      let x = ox + (i + 0.5) * spacing;
      let z = oz + (j + 0.5) * spacing;
      if (jitter > 0) {
        const jx = hash01((pointSeed ^ 0x9e3779b9) >>> 0) - 0.5;
        const jz = hash01((pointSeed ^ 0x7f4a7c15) >>> 0) - 0.5;
        x += jx * spacing * jitter;
        z += jz * spacing * jitter;
      }
      pushPoint(pts, { x, y: heightAt(x, z), z, seed: pointSeed });
      lattice++;
    }
  }
  sortBySeedCanonical(pts);
  return pts;
}

function evalDensityFilter(
  pts: PointList,
  settings: Record<string, unknown>,
): PointList {
  const density = settings.density as number;
  const seed = settings.seed as number;
  const keep = new Uint8Array(pts.count);
  for (let i = 0; i < pts.count; i++) {
    keep[i] = hash01((pts.seed[i] ^ seed) >>> 0) < density ? 1 : 0;
  }
  compactPoints(pts, keep);
  return pts;
}

function evalSlopeFilter(
  pts: PointList,
  settings: Record<string, unknown>,
  ctx: Ctx,
): PointList {
  if (!ctx.heightAt) {
    throw new Error("slopeFilter requires ctx.heightAt (chunk heightfield)");
  }
  const maxSlope = settings.maxSlope as number;
  const heightAt = ctx.heightAt;
  const e = 0.5;
  const keep = new Uint8Array(pts.count);
  for (let i = 0; i < pts.count; i++) {
    const x = pts.px[i];
    const z = pts.pz[i];
    const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
    const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
    const slope = Math.sqrt(gx * gx + gz * gz);
    keep[i] = slope <= maxSlope ? 1 : 0;
  }
  compactPoints(pts, keep);
  return pts;
}

function evalAttributeFilter(
  pts: PointList,
  settings: Record<string, unknown>,
): PointList {
  const name = settings.attribute as string;
  const col = pts.attrs.get(name);
  if (!col) throw new Error(`attributeFilter: unknown attribute "${name}"`);
  const min = settings.min as number;
  const max = settings.max as number;
  const keep = new Uint8Array(pts.count);
  for (let i = 0; i < pts.count; i++) {
    keep[i] = col[i] >= min && col[i] <= max ? 1 : 0;
  }
  compactPoints(pts, keep);
  return pts;
}

function evalSetAttribute(
  pts: PointList,
  settings: Record<string, unknown>,
): PointList {
  const col = attrColumn(pts, settings.attribute as string);
  const value = settings.value as number;
  for (let i = 0; i < pts.count; i++) col[i] = value;
  return pts;
}

function evalTransformPoints(
  pts: PointList,
  settings: Record<string, unknown>,
): PointList {
  const yawMin = settings.yawMin as number;
  const yawMax = settings.yawMax as number;
  const scaleMin = settings.scaleMin as number;
  const scaleMax = settings.scaleMax as number;
  const seed = settings.seed as number;
  const saltYaw = hashU32((seed ^ 0x12345678) >>> 0);
  const saltScale = hashU32((seed ^ 0x87654321) >>> 0);
  for (let i = 0; i < pts.count; i++) {
    const ps = pts.seed[i];
    pts.yaw[i] = yawMin + hash01((ps ^ saltYaw) >>> 0) * (yawMax - yawMin);
    const s = scaleMin + hash01((ps ^ saltScale) >>> 0) * (scaleMax - scaleMin);
    pts.sx[i] = s;
    pts.sy[i] = s;
    pts.sz[i] = s;
  }
  return pts;
}

function evalMeshSpawner(
  pts: PointList,
  settings: Record<string, unknown>,
): SpawnRecord[] {
  const entries = settings.entries as Array<{ asset: string; weight: number }>;
  const seed = settings.seed as number;
  const total = entries.reduce((a, e) => a + e.weight, 0);
  const out: SpawnRecord[] = [];
  for (let i = 0; i < pts.count; i++) {
    const ps = pts.seed[i];
    let r = hash01((ps ^ seed) >>> 0) * total;
    let asset = entries[entries.length - 1].asset;
    for (const e of entries) {
      r -= e.weight;
      if (r < 0) {
        asset = e.asset;
        break;
      }
    }
    const attrs: Record<string, number> = {};
    for (const [name, col] of pts.attrs) attrs[name] = col[i];
    out.push({
      x: pts.px[i],
      y: pts.py[i],
      z: pts.pz[i],
      yaw: pts.yaw[i],
      pitch: pts.pitch[i],
      roll: pts.roll[i],
      sx: pts.sx[i],
      sy: pts.sy[i],
      sz: pts.sz[i],
      asset,
      variantSeed: hashU32((ps ^ hashU32((seed ^ 0xabcdef) >>> 0)) >>> 0),
      seed: ps,
      attrs,
    });
  }
  return out;
}

/**
 * Evaluate a cooked plan. Returns spawn records in canonical (seed)
 * order. Authoring-time only — see module header.
 *
 * v1 graphs are linear sampler→…→spawner chains (the cooker enforces
 * this), so evaluation threads a single PointList through the
 * topologically-ordered nodes.
 */
export function evaluatePlan(plan: CookedPlan, ctx: EvalContext): SpawnRecord[] {
  const c: Ctx = {
    ...ctx,
    chunkSeed: deriveChunkSeed(ctx.worldSeed, ctx.cx, ctx.cz),
  };
  let pts: PointList | null = null;
  for (const node of plan.nodes) {
    const needInput = (): PointList => {
      if (!pts) throw new Error(`node "${node.id}" has no input data`);
      return pts;
    };
    switch (node.type) {
      case "gridSampler":
        pts = evalGridSampler(node.settings, c);
        break;
      case "densityFilter":
        pts = evalDensityFilter(needInput(), node.settings);
        break;
      case "slopeFilter":
        pts = evalSlopeFilter(needInput(), node.settings, c);
        break;
      case "attributeFilter":
        pts = evalAttributeFilter(needInput(), node.settings);
        break;
      case "setAttribute":
        pts = evalSetAttribute(needInput(), node.settings);
        break;
      case "transformPoints":
        pts = evalTransformPoints(needInput(), node.settings);
        break;
      case "meshSpawner":
        return evalMeshSpawner(needInput(), node.settings);
      default:
        throw new Error(
          `reference evaluator: unknown node type "${node.type}"`,
        );
    }
  }
  throw new Error("plan has no spawner (cooker should have rejected it)");
}
