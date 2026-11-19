/**
 * Open ground dressed as a formal garden, for the village synthesis (a garden or a churchyard parcel is never grown
 * through the enclosed-building templates).
 *
 * The layout follows how a regular garden is set out: one straight path down the middle of the plot, and on each
 * side rows of identical rectangular planters on a uniform pitch (the same gap between every pair, the grid centred
 * in its side), each with its plants spaced evenly along it. Ornamental trees stand in a line along the path and the
 * plot's outer edge, in the gaps between planter rows, so they shade the beds and the walk and never sit on a bed. A
 * churchyard keeps the same grid but its cells hold rows of headstones, evenly spaced, all facing one way.
 *
 * Pure: models come in with their effective size (native bounds times the world's scale for that model), the plot in
 * metres, and a seed that only picks which variant of a model each plant or tree uses; the spacing never depends on it.
 */

import type { SceneNode } from "@mmo-engine/scene";

export interface GardenModel {
  id: string;
  /** Effective size in metres: width (x), height (y), depth (z), after the world's scale. */
  size: readonly [number, number, number];
}

export interface GardenModels {
  /** One rectangular planter; its long side is `size[0]`. */
  planter: GardenModel;
  plants: readonly GardenModel[];
  trees: readonly GardenModel[];
  /** A headstone, for a churchyard (without one, a churchyard takes planters). */
  stones?: readonly GardenModel[];
}

export interface GardenOptions {
  /** The group node's id; parts are `<id>-g-N`. */
  id: string;
  kind: "garden" | "churchyard";
  /** The plot in metres: width across the frontage, depth away from the street. */
  widthM: number;
  depthM: number;
  models: GardenModels;
  seed: number;
  /** Where the group goes, and the yaw the parcel faces, degrees. */
  position: readonly [number, number, number];
  yawDeg: number;
  /** Clear ground kept round the edge (default 1). */
  borderM?: number;
  /** The path's width (default 1.6). */
  pathM?: number;
  /** The gap between neighbouring planters (default 1). */
  gapM?: number;
}

/** The part kinds a dressed garden is made of. */
export const GARDEN_KINDS = { path: "garden_path", planter: "garden_planter", plant: "garden_plant", tree: "garden_tree", stone: "garden_stone" } as const;

/** Open ground kinds this dresser handles. */
export const DRESSED_KINDS: ReadonlySet<string> = new Set(["garden", "churchyard"]);

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

function pick<T>(list: readonly T[], seed: number, n: number): T {
  let h = (seed ^ Math.imul(n + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  return list[h % list.length]!;
}

export interface GardenLayout {
  /** Planter rows down each side, columns across each side, and the pitch between planters. */
  rows: number;
  columns: number;
  pitchX: number;
  pitchZ: number;
}

/** The grid of cells for a plot, or null when the plot is too small for even one. */
export function gardenLayout(widthM: number, depthM: number, planter: readonly [number, number, number], o: { borderM?: number; pathM?: number; gapM?: number } = {}): GardenLayout | null {
  const border = o.borderM ?? 1;
  const path = o.pathM ?? 1.6;
  const gap = o.gapM ?? 1;
  const usableW = widthM - 2 * border;
  const usableD = depthM - 2 * border;
  // A planter lies with its long side along the path: across it is the depth, along it the width.
  const across = planter[2];
  const along = planter[0];
  const side = (usableW - path) / 2;
  const columns = Math.floor((side + gap) / (across + gap));
  const rows = Math.floor((usableD + gap) / (along + gap));
  if (columns < 1 || rows < 1) return null;
  return { rows, columns, pitchX: across + gap, pitchZ: along + gap };
}

export function dressGarden(o: GardenOptions): SceneNode {
  const { models } = o;
  const border = o.borderM ?? 1;
  const path = o.pathM ?? 1.6;
  const gap = o.gapM ?? 1;
  const stones = o.kind === "churchyard" && models.stones && models.stones.length > 0 ? models.stones : null;
  const cell = stones ? { size: [3, 1, 0.9] as const } : models.planter;
  const lay = gardenLayout(o.widthM, o.depthM, cell.size, { borderM: border, pathM: path, gapM: gap });
  const children: SceneNode[] = [];
  let n = 0;
  const add = (kind: string, name: string, asset: string, x: number, z: number, w: number, h: number, d: number, yaw: number, walkThrough: boolean): void => {
    children.push({
      id: `${o.id}-g-${n++}`,
      name,
      transform: { position: [r3(x), 0, r3(z)], rotation: [0, yaw, 0] },
      components: { Structure: { kind, asset, width: r3(w), depth: r3(d), height: r3(h) }, ...(walkThrough ? { Collider: { shape: "none" } } : {}) },
    });
  };
  const usableD = o.depthM - 2 * border;
  // The path: one slab down the middle, from the back of the plot to its front.
  add(GARDEN_KINDS.path, "garden path", "", 0, 0, path, 0.1, usableD, 0, true);
  if (lay) {
    const gridD = lay.rows * lay.pitchZ - gap;
    const z0 = -gridD / 2;
    const side = (o.widthM - 2 * border - path) / 2;
    const gridW = lay.columns * lay.pitchX - gap;
    // Each side's grid sits centred in its half of the plot, so the margin to the path and to the edge are equal.
    const xIn = path / 2 + (side - gridW) / 2;
    for (const sign of [-1, 1]) {
      for (let c = 0; c < lay.columns; c++) {
        const cx = sign * (xIn + c * lay.pitchX + cell.size[2] / 2);
        for (let r = 0; r < lay.rows; r++) {
          const cz = z0 + r * lay.pitchZ + cell.size[0] / 2;
          if (stones) {
            // A row of headstones across the cell's length, evenly spaced, all facing the same way.
            const count = Math.max(1, Math.floor(cell.size[0] / (stones[0]!.size[0] + 1.2)));
            for (let k = 0; k < count; k++) {
              const s = pick(stones, o.seed, n);
              const sz = cz - cell.size[0] / 2 + ((k + 0.5) * cell.size[0]) / count;
              add(GARDEN_KINDS.stone, "headstone", s.id, cx, sz, s.size[0], s.size[1], s.size[2], 0, false);
            }
          } else {
            add(GARDEN_KINDS.planter, "planter", models.planter.id, cx, cz, models.planter.size[2], models.planter.size[1], models.planter.size[0], 90, false);
            // The plants, evenly spaced along the bed.
            const count = Math.max(1, Math.floor(models.planter.size[0] / 0.7));
            for (let k = 0; k < count; k++) {
              const p = pick(models.plants, o.seed, n);
              const pz = cz - models.planter.size[0] / 2 + ((k + 0.5) * models.planter.size[0]) / count;
              add(GARDEN_KINDS.plant, "plant", p.id, cx, pz, p.size[0], p.size[1], p.size[2], 0, true);
            }
          }
        }
      }
      // Trees: in line along the path, and along the outer edge, in the gap after every second planter row.
      for (let r = 1; r < lay.rows; r += 2) {
        const tz = z0 + r * lay.pitchZ - gap / 2;
        const t = pick(models.trees, o.seed, n);
        add(GARDEN_KINDS.tree, "ornamental tree", t.id, sign * (path / 2 + gap / 2), tz, t.size[0], t.size[1], t.size[2], 0, true);
        const e = pick(models.trees, o.seed, n);
        add(GARDEN_KINDS.tree, "ornamental tree", e.id, sign * (o.widthM / 2 - border / 2), tz, e.size[0], e.size[1], e.size[2], 0, true);
      }
    }
  } else {
    // Too small for beds: a tree at each end of the path.
    for (const z of [-usableD / 2, usableD / 2]) {
      const t = pick(models.trees, o.seed, n);
      add(GARDEN_KINDS.tree, "ornamental tree", t.id, path / 2 + 0.5, z, t.size[0], t.size[1], t.size[2], 0, true);
    }
  }
  return { id: o.id, name: `grounds:${o.kind}`, transform: { position: [...o.position], rotation: [0, o.yawDeg, 0] }, children };
}

/** Choose the garden's models from a catalog: planter, plants, ornamental trees, headstones; null when it has no planter or tree. */
export function pickGardenModels(catalog: ReadonlyArray<{ id: string; name: string; skinned: boolean; size?: readonly number[] }>, scaleOf: (id: string) => number = () => 1): GardenModels | null {
  const usable = catalog.filter((m) => !m.skinned && m.size && m.size.length === 3 && m.size.every((v) => v > 0));
  const model = (m: (typeof usable)[number]): GardenModel => ({ id: m.id, size: [m.size![0]! * scaleOf(m.id), m.size![1]! * scaleOf(m.id), m.size![2]! * scaleOf(m.id)] });
  const named = (re: RegExp): GardenModel[] => usable.filter((m) => re.test(m.name)).sort((a, b) => a.id.localeCompare(b.id)).map(model);
  const planter = named(/^SM_Prop_PlanterBox_01$/)[0];
  // Plants no wider than the bed they stand in.
  const plants = named(/^SM_Env_Flowers_(07|08|10|13)$/);
  const trees = named(/^SM_Env_Tree_Round_0[1-4]$/);
  const stones = named(/^SM_Prop_Gravestone_0[1-5]$/);
  if (!planter || trees.length === 0 || plants.length === 0) return null;
  return { planter, plants, trees, ...(stones.length > 0 ? { stones } : {}) };
}
