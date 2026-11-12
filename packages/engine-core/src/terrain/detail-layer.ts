/**
 * The detail-layer placement evaluator: a layer (packages/art detail-layer.ts)
 * and a surface context become placements. Pure, seeded and deterministic:
 * the same layer and samples give the same placements, in the same order.
 *
 * A surface context is a list of samples. Each sample has a position, the
 * value the layer's band is tested against (distance to a wall indoors, a mask
 * channel outdoors), and an affinity 0..1 (corner-ness indoors; a moisture or
 * slope match outdoors). Two adapters build the contexts: `wallBandSamples`
 * for dungeon interiors, and `terrainSamples` for a chunk's masks.
 */
import { type DetailLayer, parseDetailLayer } from "@mmo-engine/art/browser";
import { hash01, valueNoise } from "./terrain-mask.js";

export interface DetailSample {
  x: number;
  z: number;
  /** Tested against the layer's band. */
  band: number;
  /** 0..1: how well this spot suits the layer (corner-ness, a moisture match). */
  affinity: number;
}

export interface Placement {
  x: number;
  z: number;
  /** Which asset in the layer's set (a stable index from the sample's hash). */
  variant: number;
}

/** Salts keep each draw (noise, cluster, roll, variant) independent of the others. */
const SALT = { noise: 0x51, cluster: 0x52, roll: 0x53, variant: 0x54 } as const;

function smoothstep(v: number, a: number, b: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Place one layer over a surface context. `tierScale` (0..1, default 1) thins
 * the layer for a quality tier at bake time: it multiplies the density.
 * The budget caps placements; when more are eligible, the ones with the
 * lowest roll are kept, so the cut is deterministic.
 */
export function placeDetail(layerValue: DetailLayer, samples: readonly DetailSample[], tierScale = 1): Placement[] {
  const layer = parseDetailLayer(layerValue);
  const scale = Math.min(1, Math.max(0, tierScale));
  const candidates: Array<{ x: number; z: number; roll: number; variant: number }> = [];
  for (const s of samples) {
    if (s.band < layer.band.min || s.band > layer.band.max) continue;
    const n = valueNoise(layer.seed ^ SALT.noise, s.x, s.z, layer.noise.scale);
    if (n < layer.noise.threshold) continue;

    // Affinity: at weight 0 it does not change the probability; at weight 1 a
    // sample with no affinity gets none.
    const affinity = smoothstep(s.affinity, 0, layer.affinity.preference || 1);
    const affinityFactor = 1 - layer.affinity.weight + layer.affinity.weight * affinity;

    // Clustering: placements gather where the cluster field is high.
    let clusterFactor = 1;
    if (layer.cluster.size > 0) {
      const c = valueNoise(layer.seed ^ SALT.cluster, s.x, s.z, layer.cluster.size);
      const edge = layer.cluster.falloff > 0 ? layer.cluster.falloff : 0.05;
      clusterFactor = smoothstep(c, 0.5 - edge, 0.5 + edge);
    }

    const p = layer.density * scale * affinityFactor * clusterFactor;
    const roll = hash01(Math.floor(s.x * 16) ^ (layer.seed | 0), Math.floor(s.z * 16), layer.seed ^ SALT.roll);
    if (roll >= p) continue;
    const variant = Math.floor(hash01(Math.floor(s.x * 16), Math.floor(s.z * 16), layer.seed ^ SALT.variant) * 1e6);
    candidates.push({ x: s.x, z: s.z, roll, variant });
  }

  // Budget: keep the `budget` most certain (lowest roll), then restore spatial order.
  candidates.sort((a, b) => a.roll - b.roll || a.z - b.z || a.x - b.x);
  const kept = candidates.slice(0, layer.budget);
  kept.sort((a, b) => a.z - b.z || a.x - b.x);
  return kept.map((c) => ({ x: c.x, z: c.z, variant: c.variant }));
}

/**
 * Indoor context: samples on a grid of floor cells, with the distance to the
 * nearest wall (metres) as the band and corner-ness as the affinity. `solid`
 * marks wall cells (1); the walls are the solid cells beside floor cells.
 */
export function wallBandSamples(grid: { width: number; depth: number; cell: number; solid: Uint8Array }): DetailSample[] {
  const { width: w, depth: d, cell, solid } = grid;
  const out: DetailSample[] = [];
  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (solid[i]) continue;
      // Distance to the nearest solid cell, in cells (a small scan is enough for a bake).
      let best = Infinity;
      for (let r = 1; r <= 4 && best === Infinity; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            const xx = x + dx, zz = z + dz;
            if (xx < 0 || zz < 0 || xx >= w || zz >= d) continue;
            if (solid[zz * w + xx]) best = Math.min(best, Math.hypot(dx, dz));
          }
        }
      }
      const band = (best === Infinity ? 4 : best) * cell;
      // Corner: walls on two perpendicular sides.
      const wallN = z > 0 && solid[(z - 1) * w + x] ? 1 : 0;
      const wallS = z < d - 1 && solid[(z + 1) * w + x] ? 1 : 0;
      const wallW = x > 0 && solid[z * w + x - 1] ? 1 : 0;
      const wallE = x < w - 1 && solid[z * w + x + 1] ? 1 : 0;
      const corner = (wallN + wallS > 0 && wallW + wallE > 0) ? 1 : 0;
      out.push({ x: (x + 0.5) * cell, z: (z + 0.5) * cell, band, affinity: corner });
    }
  }
  return out;
}

/**
 * Outdoor context: one sample per mask sample. The band is the mask channel
 * (0..1) the layer names, and the affinity is a moisture match (`moisture`
 * 0..1 per sample), so a moss layer can prefer wet ground.
 */
export function terrainSamples(opts: {
  width: number;
  depth: number;
  cell: number;
  originX: number;
  originZ: number;
  channel: Uint8Array;
  moisture: Uint8Array;
}): DetailSample[] {
  const out: DetailSample[] = [];
  for (let z = 0; z < opts.depth; z++) {
    for (let x = 0; x < opts.width; x++) {
      const i = z * opts.width + x;
      out.push({
        x: opts.originX + (x + 0.5) * opts.cell,
        z: opts.originZ + (z + 0.5) * opts.cell,
        band: opts.channel[i] / 255,
        affinity: opts.moisture[i] / 255,
      });
    }
  }
  return out;
}
