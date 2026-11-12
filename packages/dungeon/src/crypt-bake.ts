/**
 * Dungeon bake v1: layout mask → shell → detail layers, from one theme.
 *
 * A theme is shell settings plus an ordered list of detail layers (art
 * DetailLayer, validated here). The same mask baked under two themes gives the
 * same shell and different dressing: only the theme's data differs. The shell
 * is the existing one (shell.ts); the layers are placed by the shared evaluator
 * (@mmo-engine/placement) over the layout's wall-band and corner contexts.
 */
import { parseDetailLayer, type DetailLayer } from "@mmo-engine/art/browser";
import { buildDetailGeometry, placeDetail, wallBandSamples, type DetailGeometry, type Placement } from "@mmo-engine/placement";
import { dungeonFromLayout, parseLayoutMask, type LayoutMask } from "./mask-layout.js";
import { DUNGEON_CELL, dungeonShell, type DungeonShell, type GeometryOps, type ShellOptions } from "./shell.js";
import { CELL, type Dungeon } from "./generate.js";

export interface CryptTheme {
  id: string;
  label: string;
  shell: ShellOptions;
  /** Ordered: later layers are placed after (and may not overlap) earlier ones only by the budget. */
  layers: DetailLayer[];
}

const layer = (v: Record<string, unknown>): DetailLayer => parseDetailLayer(v);

export const CRYPT_THEMES: Record<string, CryptTheme> = {
  "dry-crypt": {
    id: "dry-crypt",
    label: "Dry crypt",
    shell: { corridorHeight: 4 },
    layers: [
      layer({ id: "rubble", assetSet: "crypt-rubble", surface: "floor", density: 0.35, noise: { scale: 3, threshold: 0.2 }, band: { min: 0, max: 1.2 }, affinity: { weight: 0, preference: 1 }, cluster: { size: 0, falloff: 0 }, seed: 101, budget: 400 }),
      layer({ id: "torch", assetSet: "crypt-torch", surface: "wall", density: 0.04, noise: { scale: 8, threshold: 0 }, band: { min: 0, max: 0.5 }, affinity: { weight: 1, preference: 1 }, cluster: { size: 0, falloff: 0 }, seed: 102, budget: 12 }),
    ],
  },
  "damp-crypt": {
    id: "damp-crypt",
    label: "Damp crypt",
    shell: { corridorHeight: 4 },
    layers: [
      layer({ id: "moss", assetSet: "crypt-moss", surface: "wall", density: 0.6, noise: { scale: 3, threshold: 0.25 }, band: { min: 0, max: 3 }, affinity: { weight: 0, preference: 1 }, cluster: { size: 4, falloff: 0.2 }, seed: 201, budget: 900 }),
      layer({ id: "mushroom", assetSet: "crypt-mushroom", surface: "floor", density: 0.5, noise: { scale: 4, threshold: 0.3 }, band: { min: 0, max: 1 }, affinity: { weight: 1, preference: 1 }, cluster: { size: 0, falloff: 0 }, seed: 202, budget: 200 }),
      layer({ id: "torch", assetSet: "crypt-torch", surface: "wall", density: 0.04, noise: { scale: 8, threshold: 0 }, band: { min: 0, max: 0.5 }, affinity: { weight: 1, preference: 1 }, cluster: { size: 0, falloff: 0 }, seed: 203, budget: 12 }),
    ],
  },
};

export interface LayerBake {
  layer: string;
  placements: Placement[];
  geometry: DetailGeometry;
}

export interface CryptBake {
  theme: string;
  shell: DungeonShell;
  details: LayerBake[];
  /** The portal entities the shell cut open (the same cells). */
  portals: Array<{ id: string; x: number; y: number; side: "x" | "y" }>;
}

/** Bake one mask under one theme: the shell, then each layer in order. */
/**
 * Bake one mask under one theme. A stacked layout passes its merged dungeon and
 * level map (stacked-layout.ts) as `stacked`; the mask is then the merged one.
 */
export function bakeCrypt(layoutValue: LayoutMask, theme: CryptTheme, geo: GeometryOps, stacked?: { dungeon: Dungeon; levels: Int8Array }): CryptBake {
  const layout = parseLayoutMask(layoutValue);
  const d = stacked ? stacked.dungeon : dungeonFromLayout(layout, theme.id);
  const shell = dungeonShell(d, geo, { ...theme.shell, cell: DUNGEON_CELL, levels: stacked?.levels });

  // Solid = anything that isn't walkable floor or pool (the wall-band context).
  const solid = new Uint8Array(d.width * d.height);
  for (let i = 0; i < solid.length; i++) solid[i] = d.grid[i] === CELL.floor || d.grid[i] === CELL.pool ? 0 : 1;
  const samples = wallBandSamples({ width: d.width, depth: d.height, cell: DUNGEON_CELL, solid });

  const details = theme.layers.map((l) => {
    const placements = placeDetail(l, samples);
    return { layer: l.id, placements, geometry: buildDetailGeometry(placements, { size: 0.5 }) };
  });
  return {
    theme: theme.id,
    shell,
    details,
    portals: layout.portals.map((p) => ({ id: p.id, x: p.x, y: p.y, side: p.side })),
  };
}
