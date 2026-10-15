/**
 * Ecology — natural placement of scenery: where trees, rocks, flowers and
 * reeds go, planned the way they form in the wild rather than scattered
 * evenly (the PCG scatter graphs do one kind of point per graph, with no
 * noise and no relations between kinds).
 *
 * A plan (content/ecology/*.ecology.json) is a list of layers, run in
 * order per chunk. A layer either samples the ground (`field`: one
 * candidate per world-space cell, jittered) or grows around the points of
 * an earlier layer (`around`: satellites), and keeps a candidate by
 * chance, scaled by
 *
 *  - noise fields in world space (`density`): groves and glades, meadow
 *    patches, rocky ground — continuous across chunk borders;
 *  - the biome at the point (`biome` group multipliers): a forest's trees
 *    thin out onto the plains, pines take the cold heights;
 *  - the slope (`slope`, `slopeBoost`): outcrops on steep ground, no trees
 *    on cliffs;
 *  - the water (`aboveWater`, `onWater`): reeds at the shoreline, lily pads
 *    afloat in the shallows;
 *  - its neighbours (`avoid`): nothing sprouts inside a trunk or a boulder.
 *
 * Satellites give the natural clumping: small rocks and scree around a
 * boulder, drifting downhill (`downhill`); ferns and mushrooms in the shade
 * at tree feet; one kind of flower per patch (`samePick`); grass collars
 * around rocks.
 *
 * Everything is a pure function of (world seed, chunk, heights, plan,
 * biome and water lookups): the same chunk always grows the same way.
 * Field cells are world-space, so a grove carries on across a chunk
 * border; a satellite that would land in the next chunk is dropped (it
 * belongs to its parent's chunk).
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fnv1a32, type EntitySpawn, type SpawnArchetype } from "@mmo-engine/scatter";
import { SCALE_CATEGORIES } from "@mmo-engine/scene";
import { terrainHeightAt } from "../systems.js";
import { bandSurfaceAt, habitatOk, HABITATS, LAND_MARGIN_M, surfaceAt, type Habitat } from "./habitat.js";
import { checkFormation, FormationCache, formationExtent, formationPieces, formationTile, pickAsset, tileOfChunk, type FormationSpec } from "./formation.js";

// ---------------------------------------------------------------- plan

export interface NoiseField {
  /** Feature size, metres (the width of a grove, a meadow). */
  scale: number;
  octaves?: number;
  seed: number;
}

export interface WeightedAsset {
  /** Art manifest model id. */
  asset: string;
  weight: number;
  /** This model's own size range (a 25 m pine stand beside 7 m broadleaves); default: the layer's. */
  scale?: [number, number];
}

/** A noise field turned into a 0–1 factor: rises from a to b, holds, falls from c to d. */
export interface DensityRamp {
  field: string;
  /** [a, b, c, d]; c and d may be omitted (no fall-off). */
  ramp: [number, number] | [number, number, number, number];
}

export type Placement =
  | {
      kind: "field";
      /** Cell size, metres: one candidate per cell (divide the chunk size for seamless borders). */
      spacing: number;
    }
  | {
      kind: "around";
      /** The layer whose points this one grows around. */
      parent: string;
      /** Chance a parent gets satellites at all. */
      chance: number;
      count: [number, number];
      /** Distance from the parent, metres (times the parent's scale when scaleWithParent). */
      radius: [number, number];
      scaleWithParent?: boolean;
      /** 0–1: how strongly satellites drift down the slope (scree). */
      downhill?: number;
    }
  | {
      /** Points decided together by WFC (see formation.ts). */
      kind: "formation";
      /** Cell size, metres: one candidate per cell. */
      spacing: number;
      /** A tile is this many chunks square (default 4); every constraint must be shorter than a tile. */
      tileChunks?: number;
    };

export interface EcologyLayer {
  id: string;
  place: Placement;
  /** Base chance a candidate is kept (field layers). */
  chance?: number;
  density?: DensityRamp[];
  /** The biome multiplier group this layer reads (plan.biomes[biome][group]). */
  biome?: string;
  /** Rise over run allowed. */
  slope?: [number, number];
  /** Extra chance per unit of slope (outcrops like steep ground). */
  slopeBoost?: number;
  /**
   * Where it lives against the water: "land" (default) stands at least the plan's `landMarginM` above
   * the sea or lake; "shore" keeps to its `aboveWater` band round the water line (reeds); "water" is
   * aquatic (coral, kelp, lily pads) and the only kind placed below it, on the floor within its `aboveWater` depths.
   */
  habitat?: Habitat;
  /** Ground height above the water surface, metres ([min, max]; max null = no limit). Required for shore and water layers (water: depths, max <= 0). */
  aboveWater?: [number, number | null];
  /** Stand on the water surface, not the ground (lily pads). */
  onWater?: boolean;
  /** Keep this far (metres) from the points of these layers. */
  avoid?: Record<string, number>;
  assets: WeightedAsset[];
  /** Per-biome asset lists overriding `assets` (pines on the cold heights). */
  biomeAssets?: Record<string, WeightedAsset[]>;
  /** Satellites of one parent share one pick (a patch of one flower). */
  samePick?: boolean;
  scale: [number, number];
  /** Not spawned: only a parent for other layers (a patch centre). */
  hidden?: boolean;
  collision?: SpawnArchetype["collision"];
  /** Kind of object for the global scale (default prop). */
  category?: SpawnArchetype["category"];
  /** A formation layer's options and constraints (place.kind "formation"). */
  formation?: FormationSpec;
}

export interface EcologyPlan {
  version: 1;
  name: string;
  fields: Record<string, NoiseField>;
  /** biome name → group → multiplier; `default` for anything unlisted (and worlds without biomes). */
  biomes: Record<string, Record<string, number>>;
  layers: EcologyLayer[];
  /** How far above the water surface land layers stand, metres (default LAND_MARGIN_M). */
  landMarginM?: number;
}

/** Read and check a plan (layer references, fields, asset lists). */
export function parseEcologyPlan(json: unknown): EcologyPlan {
  const plan = json as EcologyPlan;
  if (!plan || plan.version !== 1 || !Array.isArray(plan.layers)) throw new Error("ecology plan: want { version: 1, layers: [...] }");
  const seen = new Set<string>();
  for (const l of plan.layers) {
    if (l.category !== undefined && !(SCALE_CATEGORIES as readonly string[]).includes(l.category)) throw new Error(`ecology plan: layer "${l.id}" has unknown category "${l.category}" (have ${SCALE_CATEGORIES.join(", ")})`);
    if (seen.has(l.id)) throw new Error(`ecology plan: layer "${l.id}" twice`);
    if (l.habitat !== undefined && !HABITATS.includes(l.habitat)) throw new Error(`ecology plan: layer "${l.id}" has unknown habitat "${String(l.habitat)}" (have ${HABITATS.join(", ")})`);
    if (l.habitat === "shore" && !l.aboveWater) throw new Error(`ecology plan: shore layer "${l.id}" needs aboveWater (the band it keeps to)`);
    if (l.habitat === "water") {
      if (!l.aboveWater) throw new Error(`ecology plan: water layer "${l.id}" needs aboveWater, its depth range (negative metres)`);
      if (l.aboveWater[0] > 0 || (l.aboveWater[1] ?? 1) > 0) throw new Error(`ecology plan: water layer "${l.id}" must stay below the water (aboveWater max <= 0)`);
    }
    if (l.place.kind === "around" && !seen.has(l.place.parent)) {
      throw new Error(`ecology plan: layer "${l.id}" grows around "${l.place.parent}", which must come before it`);
    }
    for (const d of l.density ?? []) {
      if (!plan.fields[d.field]) throw new Error(`ecology plan: layer "${l.id}" reads unknown field "${d.field}"`);
    }
    for (const other of Object.keys(l.avoid ?? {})) {
      if (!seen.has(other) && other !== l.id) throw new Error(`ecology plan: layer "${l.id}" avoids "${other}", which must come before it`);
    }
    if (l.place.kind === "formation") checkFormation(l);
    else if (l.assets.length === 0 && !l.hidden) throw new Error(`ecology plan: layer "${l.id}" has no assets`);
    seen.add(l.id);
  }
  return plan;
}

export function loadEcologyPlan(file: string): { plan: EcologyPlan; hash: string } {
  const text = readFileSync(file, "utf8");
  return { plan: parseEcologyPlan(JSON.parse(text)), hash: createHash("sha256").update(text).digest("hex") };
}

// --------------------------------------------------------------- random

function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A 32-bit hash of integers. */
export function hash(...ns: number[]): number {
  let h = 0x9e3779b9;
  for (const n of ns) h = mix((h ^ (n | 0)) >>> 0) ^ Math.imul(h, 0x27d4eb2d);
  return mix(h >>> 0);
}

/** The 32-bit seed every layer's randomness derives from. */
export function ecologySeed32(worldSeed: bigint): number {
  return mix((Number(worldSeed & 0xffffffffn) ^ Number((worldSeed >> 32n) & 0xffffffffn)) >>> 0);
}

/** A hash as a number in [0, 1). */
const unit = (h: number): number => h / 4294967296;

const smooth = (t: number): number => t * t * (3 - 2 * t);

function valueNoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = smooth(x - xi);
  const fz = smooth(z - zi);
  const a = unit(hash(seed, xi, zi));
  const b = unit(hash(seed, xi + 1, zi));
  const c = unit(hash(seed, xi, zi + 1));
  const d = unit(hash(seed, xi + 1, zi + 1));
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** Fractal value noise in [0, 1] at world (x, z). */
export function fieldAt(f: NoiseField, x: number, z: number): number {
  const octaves = f.octaves ?? 3;
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let freq = 1 / f.scale;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, z * freq, f.seed + o * 1013);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** A trapezoid ramp: 0 → 1 from a to b, 1 → 0 from c to d. */
export function ramp(v: number, r: DensityRamp["ramp"]): number {
  const [a, b] = r;
  const c = r.length === 4 ? r[2] : Infinity;
  const d = r.length === 4 ? r[3] : Infinity;
  if (v <= a || v >= d) return 0;
  if (v < b) return smooth((v - a) / (b - a));
  if (v > c) return smooth((d - v) / (d - c));
  return 1;
}

// ------------------------------------------------------------- planning

export interface EcologyContext {
  /** Region world seed. */
  worldSeed: bigint;
  cx: number;
  cz: number;
  /** The chunk's heights (side × side, row-major), as the ground is drawn. */
  heights: Float32Array;
  chunkWorldSize: number;
  /** Biome name at world (x, z); absent or null → the plan's `default`. */
  biomeAt?: (x: number, z: number) => string | null;
  /** Water surface at world (x, z) (sea or lake), or null where there is none near. */
  waterAt?: (x: number, z: number) => number | null;
  /** Sea level, when there's no water lookup. */
  seaLevel?: number;
  /** Heights of any chunk: formation layers read the chunks their tiles span and border. */
  heightsOf?: (cx: number, cz: number) => Float32Array;
  /** Solved formation tiles, kept across chunks (default: a fresh cache per call). */
  formations?: FormationCache;
}

/** A placed point: the spawn plus what later layers read. */
export interface EcologyPoint extends EntitySpawn {
  layer: string;
  scale: number;
}

function pick(list: WeightedAsset[], r: number): WeightedAsset {
  let total = 0;
  for (const a of list) total += a.weight;
  let t = r * total;
  for (const a of list) {
    t -= a.weight;
    if (t < 0) return a;
  }
  return list[list.length - 1];
}

/** Plan one chunk: every layer's points, in layer order. */
export function planChunk(plan: EcologyPlan, ctx: EcologyContext): EcologyPoint[] {
  const W = ctx.chunkWorldSize;
  const x0 = ctx.cx * W;
  const z0 = ctx.cz * W;
  const seed32 = ecologySeed32(ctx.worldSeed);
  const ground = (x: number, z: number): number => terrainHeightAt(ctx.heights, x - x0, z - z0, W);
  const slopeAt = (x: number, z: number): { slope: number; dx: number; dz: number } => {
    const e = 0.5;
    const cxm = Math.max(x0, x - e);
    const cxp = Math.min(x0 + W, x + e);
    const czm = Math.max(z0, z - e);
    const czp = Math.min(z0 + W, z + e);
    const dx = (ground(cxp, z) - ground(cxm, z)) / (cxp - cxm);
    const dz = (ground(x, czp) - ground(x, czm)) / (czp - czm);
    return { slope: Math.hypot(dx, dz), dx, dz };
  };
  const water = (x: number, z: number): number | null => surfaceAt(ctx.waterAt, ctx.seaLevel, x, z);
  const margin = plan.landMarginM ?? LAND_MARGIN_M;
  const biomeOf = (x: number, z: number): string => ctx.biomeAt?.(x, z) ?? "default";
  const biomeFactor = (layer: EcologyLayer, biome: string): number => {
    if (!layer.biome) return 1;
    return plan.biomes[biome]?.[layer.biome] ?? plan.biomes.default?.[layer.biome] ?? 1;
  };

  const placed = new Map<string, EcologyPoint[]>();
  const out: EcologyPoint[] = [];

  for (const layer of plan.layers) {
    const layerSeed = hash(seed32, fnv1a32(layer.id));
    const mine: EcologyPoint[] = [];
    placed.set(layer.id, mine);

    /** Try a candidate at (x, z); r(k) is its own random stream. Returns the point or null. */
    const tryAt = (x: number, z: number, baseChance: number, r: (k: number) => number, forcedAsset: WeightedAsset | null, id: number): EcologyPoint | null => {
      if (x < x0 || x >= x0 + W || z < z0 || z >= z0 + W) return null;
      const biome = biomeOf(x, z);
      let p = baseChance * biomeFactor(layer, biome);
      if (p <= 0) return null;
      for (const d of layer.density ?? []) p *= ramp(fieldAt(plan.fields[d.field], x, z), d.ramp);
      if (p <= 0) return null;
      const { slope } = slopeAt(x, z);
      if (layer.slope && (slope < layer.slope[0] || slope > layer.slope[1])) return null;
      if (layer.slopeBoost) p *= 1 + layer.slopeBoost * slope;
      if (r(0) >= p) return null;
      const g = ground(x, z);
      const w = water(x, z);
      if (!habitatOk(layer, margin, g, w, bandSurfaceAt(ctx.waterAt, ctx.seaLevel, x, z))) return null;
      for (const [other, dist] of Object.entries(layer.avoid ?? {})) {
        for (const q of placed.get(other) ?? []) {
          const dx = q.x - x;
          const dz = q.z - z;
          if (dx * dx + dz * dz < dist * dist) return null;
        }
      }
      const assets = layer.biomeAssets?.[biome] ?? layer.assets;
      const chosen = forcedAsset ?? (assets.length > 0 ? pick(assets, r(1)) : { asset: "", weight: 1 });
      const asset = chosen.asset;
      const [s0, s1] = chosen.scale ?? layer.scale;
      const scale = s0 + (s1 - s0) * r(2);
      const y = layer.onWater && w !== null ? w : g;
      const archetype: SpawnArchetype = { asset, ...(layer.collision ? { collision: layer.collision } : {}), ...(layer.category ? { category: layer.category } : {}) };
      return {
        layer: layer.id,
        x,
        y,
        z,
        yaw: r(3) * Math.PI * 2,
        pitch: 0,
        roll: 0,
        sx: scale,
        sy: scale,
        sz: scale,
        scale,
        assetId: asset,
        assetHash: fnv1a32(asset),
        variant: 0,
        seed: id,
        archetype,
      };
    };

    const place = layer.place;
    if (place.kind === "formation") {
      if (!ctx.heightsOf) throw new Error(`ecology plan: layer "${layer.id}" is a formation, which needs the terrain (heightsOf) to read neighbouring chunks`);
      const env = { seed32, chunkWorldSize: W, heightsOf: ctx.heightsOf, biomeAt: ctx.biomeAt, waterAt: ctx.waterAt, seaLevel: ctx.seaLevel };
      const f = layer.formation as FormationSpec;
      const cache = ctx.formations ?? new FormationCache();
      const pieces = formationPieces(f);
      // Pieces of a formation sited in a neighbouring tile can land in this chunk,
      // and later layers avoid this one across chunk borders: gather its points
      // within both reaches of the chunk (spawning only our own).
      let margin = formationExtent(f);
      for (const other of plan.layers) margin = Math.max(margin, other.avoid?.[layer.id] ?? 0);
      const [ta, tb] = tileOfChunk(layer, Math.floor((x0 - margin) / W), Math.floor((z0 - margin) / W));
      const [tc, td] = tileOfChunk(layer, Math.floor((x0 + W + margin) / W), Math.floor((z0 + W + margin) / W));
      const near: typeof mine = [];
      const tilePoints = [];
      for (let tj = tb; tj <= td; tj++) for (let ti = ta; ti <= tc; ti++) tilePoints.push(...formationTile(plan, layer, env, cache, ti, tj));
      for (const fp of tilePoints) {
        if (fp.x < x0 - margin || fp.x >= x0 + W + margin || fp.z < z0 - margin || fp.z >= z0 + W + margin) continue;
        const own = fp.x >= x0 && fp.x < x0 + W && fp.z >= z0 && fp.z < z0 + W;
        // A piece the ground puts in or at the water is dropped (its site's cell passed; the piece may not).
        if (fp.option >= 0 && !habitatOk(layer, margin, fp.y, water(fp.x, fp.z), bandSurfaceAt(ctx.waterAt, ctx.seaLevel, fp.x, fp.z))) continue;
        // A piece, or a site's unseen centre (option < 0: avoided, never spawned).
        const piece = fp.option >= 0 ? pieces[fp.option].piece : null;
        const r = (k: number): number => unit(hash(layerSeed, fp.i, fp.j, k));
        const chosen = piece ? pickAsset(piece.assets, r(1)) : null;
        const asset = chosen?.asset ?? "";
        const [s0, s1] = chosen?.scale ?? piece?.scale ?? layer.scale;
        const scale = s0 + (s1 - s0) * r(2);
        const pt: EcologyPoint = {
          layer: layer.id,
          x: fp.x,
          // Where the raymarcher set it on the ground.
          y: fp.y,
          z: fp.z,
          yaw: r(3) * Math.PI * 2,
          pitch: 0,
          roll: 0,
          sx: scale,
          sy: scale,
          sz: scale,
          scale,
          assetId: asset,
          assetHash: fnv1a32(asset),
          variant: 0,
          seed: hash(layerSeed, fp.i, fp.j),
          archetype: { asset, ...(layer.collision ? { collision: layer.collision } : {}), ...(layer.category ? { category: layer.category } : {}) },
        };
        // Every point is there for later layers to avoid; only this chunk's, with art, are spawned.
        if (own) mine.push(pt);
        else near.push(pt);
        if (own && asset && !layer.hidden) out.push(pt);
      }
      mine.push(...near);
      continue;
    }
    if (place.kind === "field") {
      const s = place.spacing;
      for (let i = Math.ceil(x0 / s - 1e-9); i * s < x0 + W - 1e-9; i++) {
        for (let j = Math.ceil(z0 / s - 1e-9); j * s < z0 + W - 1e-9; j++) {
          // World-space cells: the same cell draws the same numbers in any chunk.
          const r = (k: number): number => unit(hash(layerSeed, i, j, k));
          const x = (i + 0.05 + 0.9 * r(10)) * s;
          const z = (j + 0.05 + 0.9 * r(11)) * s;
          const pt = tryAt(x, z, layer.chance ?? 1, r, null, hash(layerSeed, i, j));
          if (pt) mine.push(pt);
        }
      }
    } else {
      for (const parent of placed.get(place.parent) ?? []) {
        const px = Math.round(parent.x * 100);
        const pz = Math.round(parent.z * 100);
        const pr = (k: number): number => unit(hash(layerSeed, px, pz, k));
        if (pr(0) >= place.chance * biomeFactor(layer, biomeOf(parent.x, parent.z))) continue;
        const n = place.count[0] + Math.floor(pr(1) * (place.count[1] - place.count[0] + 1));
        const shared = layer.samePick ? pick(layer.biomeAssets?.[biomeOf(parent.x, parent.z)] ?? layer.assets, pr(2)) : null;
        const reach = place.scaleWithParent ? parent.scale : 1;
        const down = place.downhill ? slopeAt(parent.x, parent.z) : null;
        for (let c = 0; c < n; c++) {
          const r = (k: number): number => unit(hash(layerSeed, px, pz, 1000 + c * 32 + k));
          const dist = (place.radius[0] + (place.radius[1] - place.radius[0]) * r(10)) * reach;
          let ax = Math.cos(r(11) * Math.PI * 2);
          let az = Math.sin(r(11) * Math.PI * 2);
          if (down && down.slope > 0.02 && place.downhill) {
            // Scree runs down the fall line: bend the direction toward -gradient.
            const k = place.downhill * (0.5 + 0.5 * r(12));
            const gx = -down.dx / down.slope;
            const gz = -down.dz / down.slope;
            ax = ax * (1 - k) + gx * k;
            az = az * (1 - k) + gz * k;
            const len = Math.hypot(ax, az) || 1;
            ax /= len;
            az /= len;
          }
          const pt = tryAt(parent.x + ax * dist, parent.z + az * dist, 1, r, shared, hash(layerSeed, px, pz, c));
          if (pt) mine.push(pt);
        }
      }
    }
    if (!layer.hidden) out.push(...mine);
  }
  return out;
}
