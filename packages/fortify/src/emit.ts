/**
 * The emitter: a fortified settlement becomes a SettlementBake — placed
 * structures in world coordinates, ready to persist with the world bake
 * and spawn from. Vectors stay vectors (the bake contract's rule): wall
 * runs and the approach are polylines of world points, not raster.
 *
 * Every placement carries provenance: which build step created it (the
 * settlement's architectural history), "as-generated" for the original
 * layout, or "doctrine" for a culture's stamped answers.
 */

import { idx, tx, ty, type FaceId, type Settlement } from "./model.js";
import type { TacticId } from "./matrix.js";
import type { BuildStep, FortifyResult, StopReason } from "./fortify.js";
import { wallFaces } from "./analyze.js";
import { tileToWorld, type SiteTransform } from "./survey.js";

export type StructureKind =
  | "wall-run"
  | "tower"
  | "gate"
  | "barbican"
  | "keep"
  | "moat"
  | "lilia-field"
  | "well"
  | "granary";

export interface Decoration {
  material: string;
  /** Nominal height of the structure, metres. */
  heightM: number;
  dressing: string[];
}

export interface StructurePlacement {
  kind: StructureKind;
  /** Point structures: world position [x, z], metres. */
  world?: [number, number];
  /** Linear structures (wall runs, the approach): world polyline. */
  polyline?: Array<[number, number]>;
  /** Areal structures (moat, lilia): world positions of their tiles. */
  tiles?: Array<[number, number]>;
  /** Tower form, when kind is "tower". */
  form?: "square" | "round";
  /** Wall face, when kind is "wall-run". */
  face?: FaceId;
  /** Build step that created this, "as-generated", or "doctrine". */
  provenance: string;
  decoration?: Decoration;
}

export interface SettlementBake {
  version: 1;
  name: string;
  /** The survey window this settlement occupies. */
  site: { u0: number; v0: number; size: number; cell: number };
  placements: StructurePlacement[];
  /** The final cheapest approach, as a world polyline. */
  approach: { polyline: Array<[number, number]>; turns: number; finalStraight: number };
  buildLog: BuildStep[];
  exposures: Record<TacticId, number>;
  stopReason: StopReason;
  spent: number;
}

/** Provenance label for a structure the loop built at a known step. */
const stepProvenance = (log: BuildStep[], counter: string, n: number): string => {
  const hits = log.filter((l) => l.counter === counter);
  const hit = hits[Math.min(n, hits.length - 1)];
  return hit ? `step ${hit.step}: ${hit.counter}` : "as-generated";
};

export function emitSettlementBake(
  s: Settlement,
  result: FortifyResult,
  t: SiteTransform,
): SettlementBake {
  const g = s.grid;
  const at = (i: number): [number, number] => tileToWorld(t, tx(g, i), ty(g, i));
  const placements: StructurePlacement[] = [];
  const log = result.log;

  // Wall runs: one polyline per face, corners shared between faces.
  const faces = wallFaces(s);
  for (const face of ["north", "east", "south", "west"] as FaceId[]) {
    const tiles = [...faces[face]].sort((a, b) => a - b);
    if (tiles.length === 0) continue;
    placements.push({
      kind: "wall-run",
      face,
      polyline: tiles.map(at),
      provenance: "as-generated",
    });
  }

  // Towers: the two originals sit on the ring's north corners. Anything
  // else was raised by the loop as a flanking tower; a tower rebuilt
  // round carries its rounding step as provenance.
  let wallMinX = Infinity;
  let wallMaxX = -Infinity;
  let wallMinY = Infinity;
  for (const i of s.walls) {
    wallMinX = Math.min(wallMinX, tx(g, i));
    wallMaxX = Math.max(wallMaxX, tx(g, i));
    wallMinY = Math.min(wallMinY, ty(g, i));
  }
  let flanking = 0;
  let rounded = 0;
  for (const tower of s.towers) {
    const base: StructurePlacement = {
      kind: "tower",
      world: tileToWorld(t, tower.x, tower.y),
      form: tower.form,
      provenance: "as-generated",
    };
    const onOriginalCorner = tower.y === wallMinY && (tower.x === wallMinX || tower.x === wallMaxX);
    if (!onOriginalCorner) base.provenance = stepProvenance(log, "flanking-tower", flanking++);
    if (tower.form === "round") {
      const rp = stepProvenance(log, "round-tower", rounded++);
      if (rp !== "as-generated") base.provenance = rp;
    }
    placements.push(base);
  }

  placements.push({ kind: "gate", world: at(s.gate), provenance: "as-generated" });
  placements.push({ kind: "keep", world: at(s.core), provenance: "as-generated" });
  if (s.barbican !== null) {
    placements.push({
      kind: "barbican",
      world: at(s.barbican),
      provenance: stepProvenance(log, "barbican", 0),
    });
  }
  if (s.moat.size > 0) {
    placements.push({
      kind: "moat",
      tiles: [...s.moat].map(at),
      provenance: stepProvenance(log, "moat", 0),
    });
  }
  if (s.obstacles.size > 0) {
    placements.push({
      kind: "lilia-field",
      tiles: [...s.obstacles].map(at),
      provenance: stepProvenance(log, "lilia", 0),
    });
  }
  if (s.stores.well) {
    placements.push({
      kind: "well",
      world: tileToWorld(t, tx(g, s.core) - 3, ty(g, s.core)),
      provenance: stepProvenance(log, "internal-well", 0),
    });
  }
  if (s.stores.granary) {
    placements.push({
      kind: "granary",
      world: tileToWorld(t, tx(g, s.core) + 3, ty(g, s.core)),
      provenance: stepProvenance(log, "granary", 0),
    });
  }

  const approachPath = result.analysis.approach.path ?? [];
  return {
    version: 1,
    name: s.name,
    site: { u0: t.u0, v0: t.v0, size: g.w, cell: t.cell },
    placements,
    approach: {
      polyline: approachPath.map(at),
      turns: result.analysis.approach.turns,
      finalStraight: result.analysis.approach.finalStraight,
    },
    buildLog: log,
    exposures: result.analysis.exposures,
    stopReason: result.stopReason,
    spent: result.spent,
  };
}
