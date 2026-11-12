/**
 * Bake one detail layer over a surface context: placements, then the merged
 * cross-quad geometry for them. This is the bake-time step; the runtime only
 * draws the buffers it returns.
 */
import type { DetailLayer } from "@mmo-engine/art/browser";
import { placeDetail, type DetailSample } from "./detail-layer.js";
import { buildDetailGeometry, type DetailGeometry } from "./detail-geometry.js";

export interface DetailBake {
  layer: string;
  placements: ReturnType<typeof placeDetail>;
  geometry: DetailGeometry;
}

export function bakeDetailLayer(
  layer: DetailLayer,
  samples: readonly DetailSample[],
  opts: { size: number; tierScale?: number; height?: (x: number, z: number) => number },
): DetailBake {
  const placements = placeDetail(layer, samples, opts.tierScale ?? 1);
  const geometry = buildDetailGeometry(placements, { size: opts.size, height: opts.height });
  return { layer: layer.id, placements, geometry };
}
