/**
 * Street ribbons for the settlement scene (roadmap SG2b). A paved street the router bent (`roads.edges[].path`) becomes a
 * ribbon: its centreline and a left and right rail, offset by half its width either side, each with the terrain height of
 * the sample it came from. The scene keeps its walk-through slabs for the server; the client draws these ribbons instead, from
 * the sidecar `<scene>.ribbons.json` the bake writes beside the scene.
 *
 * Pure arrays, metres, scene coordinates (the same frame `settlementScene` uses for its nodes), x, y, z triples per sample.
 * Kept free of engine-core imports: engine-core depends on this package, so the spline itself stays in engine-core and the
 * rails here are the offset of the router's own polyline.
 */
import type { SettlementManifest } from "./generate.js";

export interface StreetRibbon {
  readonly edgeId: string;
  readonly roadClass: string;
  readonly widthM: number;
  /** Centreline samples: x, y, z per point. */
  readonly center: number[];
  /** Left and right rails: x, y, z per point, one per centreline sample. */
  readonly left: number[];
  readonly right: number[];
}

/**
 * The ribbon for one routed street. `path` is the router's centreline in mm (x, z) with heights in metres (y).
 * Returns null for a street with fewer than two points, or with no width.
 */
export function streetRibbon(
  edge: { id: string; roadClass: string; widthMm: number },
  path: ReadonlyArray<{ x: number; z: number; h: number }>,
): StreetRibbon | null {
  if (path.length < 2 || !(edge.widthMm > 0)) return null;
  const half = edge.widthMm / 2000; // metres
  const n = path.length;
  const center: number[] = [];
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = path[i]!;
    // Heading at this sample: the chord through its neighbours (one-sided at the two ends).
    const a = path[Math.max(0, i - 1)]!;
    const b = path[Math.min(n - 1, i + 1)]!;
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const d = Math.hypot(dx, dz);
    if (d === 0) {
      dx = 1;
      dz = 0;
    } else {
      dx /= d;
      dz /= d;
    }
    // Normal to the heading, in the xz plane (the rail sits to the left or right of the centreline).
    const nx = -dz;
    const nz = dx;
    const x = p.x / 1000;
    const y = p.h;
    const z = p.z / 1000;
    center.push(x, y, z);
    left.push(x + nx * half, y, z + nz * half);
    right.push(x - nx * half, y, z - nz * half);
  }
  return { edgeId: edge.id, roadClass: edge.roadClass, widthM: edge.widthMm / 1000, center, left, right };
}

/** Every routed paved street of a town, as ribbons. Streets without a router's path have none (their slabs stay). */
export function streetRibbons(manifest: SettlementManifest): StreetRibbon[] {
  const out: StreetRibbon[] = [];
  for (const e of manifest.roads.edges) {
    if (e.surface !== "paved" || !e.path) continue;
    const r = streetRibbon(e, e.path);
    if (r) out.push(r);
  }
  return out;
}
