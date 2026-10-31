import * as THREE from "three";
import { z } from "zod";
import { DeterministicRng } from "./synthesizer.js";
import type { LearnedRuleSet, PartDef, SynthesizedPlacement, Vec3Tuple } from "./types.js";

/**
 * Interior grammars: a room is a plan on a grid of cells, and the rules place
 * floor, walls and doorways from it. A style says which part category fills
 * each feature; an interior id names a grammar and a style.
 */

export const INTERIOR_GRAMMAR_FORMAT = "mmo-interior-grammar/1";

/** The longest plan side, in cells. Bounds how many parts one plan can place. */
export const MAX_PLAN_CELLS = 64;

type Side = "N" | "S" | "E" | "W";
type Feature = "floor" | "wall" | "door";
interface Cell {
  c: number;
  r: number;
}
interface Door {
  side: Side;
  index: number;
}

const Id = z.string().regex(/^[a-z][a-z0-9-]*$/);
const SideSchema = z.enum(["N", "S", "E", "W"]);

export const InteriorGrammarSchema = z
  .object({
    format: z.literal(INTERIOR_GRAMMAR_FORMAT),
    id: Id,
    /** Edge length of one plan cell, metres. */
    cellM: z.number().positive().max(50).default(5),
    /** Height of walls and doorways, metres. */
    wallHeightM: z.number().positive().max(30).default(4),
    /** Width of a doorway's opening, metres. The wall either side of it fills the rest of the cell's edge. */
    doorwayM: z.number().positive().max(50).default(2.5),
    /** The plan, row 0 at the north (-z) edge: "." a floor cell, "#" solid. */
    plan: z.array(z.string().min(1).max(MAX_PLAN_CELLS).regex(/^[.#]+$/)).min(1).max(MAX_PLAN_CELLS),
    /** Doorways in the outer wall: a side, and the cell along it counted from the west (N, S) or north (E, W) end. */
    doors: z.array(z.object({ side: SideSchema, index: z.number().int().min(0) })).default([]),
  })
  .superRefine((g, ctx) => {
    if (g.plan.length === 0) return;
    const width = g.plan[0].length;
    g.plan.forEach((row, r) => {
      if (row.length !== width) ctx.addIssue({ code: "custom", path: ["plan", r], message: `plan row ${r} is ${row.length} cells, row 0 is ${width}` });
    });
    if (g.doorwayM > g.cellM) {
      ctx.addIssue({ code: "custom", path: ["doorwayM"], message: `doorway ${g.doorwayM} m is wider than its ${g.cellM} m cell` });
    }
    if (!g.plan.some((row) => row.includes("."))) {
      ctx.addIssue({ code: "custom", path: ["plan"], message: "plan has no floor cell" });
    }
    const seen = new Set<string>();
    g.doors.forEach((d, i) => {
      const path = ["doors", i];
      if (!doorwayOnSide(g.plan, d)) {
        ctx.addIssue({ code: "custom", path, message: `doorway ${d.side}${d.index} is past the end of its side` });
        return;
      }
      const key = cellKey(doorwayCell(g.plan, d), d.side);
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path, message: `doorway ${d.side}${d.index} is listed twice` });
        return;
      }
      seen.add(key);
      if (!isOuterDoorway(g.plan, d)) {
        ctx.addIssue({ code: "custom", path, message: `doorway ${d.side}${d.index} is not on a floor cell of the outer wall` });
      }
    });
  });
export type InteriorGrammar = z.infer<typeof InteriorGrammarSchema>;

export const InteriorStyleSchema = z.object({
  id: Id,
  /** Part category per feature; a feature left out uses its own name as the category. */
  categories: z
    .object({ floor: z.string(), wall: z.string(), door: z.string() })
    .partial()
    .default({}),
});
export type InteriorStyle = z.infer<typeof InteriorStyleSchema>;

export const InteriorCatalogSchema = z.object({
  version: z.literal(1),
  /** Interior id to the grammar it uses, the style it wears, and the seed that picks its parts. */
  interiors: z.record(Id, z.object({ grammar: Id, style: Id, seed: z.number().int().min(0).default(1) })),
});
export type InteriorCatalog = z.infer<typeof InteriorCatalogSchema>;

const SIDE_STEP: Record<Side, Cell> = {
  N: { c: 0, r: -1 },
  S: { c: 0, r: 1 },
  W: { c: -1, r: 0 },
  E: { c: 1, r: 0 },
};
const SIDE_ORDER: Side[] = ["N", "S", "W", "E"];
/** A wall's front turns into the room: a part's front is +z at yaw 0, so a north wall (room to the south) takes 0. */
const WALL_YAW: Record<Side, number> = { N: 0, S: Math.PI, W: Math.PI / 2, E: -Math.PI / 2 };
const UP = new THREE.Vector3(0, 1, 0);

const cellAt = (plan: string[], { c, r }: Cell): string | undefined => plan[r]?.[c];
const isFloor = (plan: string[], cell: Cell): boolean => cellAt(plan, cell) === ".";
const step = (cell: Cell, side: Side): Cell => ({ c: cell.c + SIDE_STEP[side].c, r: cell.r + SIDE_STEP[side].r });
const cellKey = (cell: Cell, side: Side): string => `${cell.c},${cell.r},${side}`;

/** True when the door's index is inside its side of the plan. */
function doorwayOnSide(plan: string[], door: Door): boolean {
  const along = door.side === "N" || door.side === "S" ? plan[0].length : plan.length;
  return door.index < along;
}

/** The floor-or-solid cell whose outer edge on the door's side holds the doorway. */
function doorwayCell(plan: string[], door: Door): Cell {
  const cols = plan[0].length;
  const rows = plan.length;
  switch (door.side) {
    case "N": return { c: door.index, r: 0 };
    case "S": return { c: door.index, r: rows - 1 };
    case "W": return { c: 0, r: door.index };
    case "E": return { c: cols - 1, r: door.index };
  }
}

/** True when the doorway's cell is floor and its outer edge faces off the plan. */
function isOuterDoorway(plan: string[], door: Door): boolean {
  const cell = doorwayCell(plan, door);
  return isFloor(plan, cell) && !isFloor(plan, step(cell, door.side));
}

/** Scale that stretches a part's native extent to the wanted one; a flat asset (zero extent) keeps scale 1. */
const fit = (native: number, wanted: number): number => (native > 0 ? wanted / native : 1);

/**
 * Put a grammar's plan into the world: a floor part per floor cell, a wall
 * part on every floor edge that faces off the plan. A doorway cuts a gap in
 * its wall: a door part fills the opening, with a wall segment either side.
 * Each part is scaled to its cell, wall or segment, and its size is that
 * extent even when the asset is flat. Floor centres sit at
 * y = 0; walls at half their height. Every part the plan needs is named before
 * any is placed, so a style with a gap fails before it lays anything.
 */
export function placeInterior(
  grammar: InteriorGrammar,
  style: InteriorStyle,
  ruleSet: LearnedRuleSet,
  seed: number,
): SynthesizedPlacement[] {
  const { plan, cellM, wallHeightM, doorwayM } = grammar;
  // Each wall segment beside a doorway: the rest of the cell's edge, split evenly either side.
  const segM = (cellM - doorwayM) / 2;
  const cols = plan[0].length;
  const rows = plan.length;
  const doorways = new Set(grammar.doors.map((d) => cellKey(doorwayCell(plan, d), d.side)));
  const floorCells: Cell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (isFloor(plan, { c, r })) floorCells.push({ c, r });
    }
  }
  const facesOff = (cell: Cell): Side[] => SIDE_ORDER.filter((side) => !isFloor(plan, step(cell, side)));

  const needed = new Set<Feature>(["floor"]);
  for (const cell of floorCells) {
    for (const side of facesOff(cell)) {
      if (!doorways.has(cellKey(cell, side))) {
        needed.add("wall");
      } else {
        needed.add("door");
        if (segM > 0) needed.add("wall");
      }
    }
  }
  const parts = Object.values(ruleSet.parts).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lists = new Map<Feature, PartDef[]>();
  const missing: string[] = [];
  for (const feature of needed) {
    const category = style.categories[feature] ?? feature;
    const list = parts.filter((p) => p.category === category);
    if (list.length === 0) missing.push(`no "${category}" parts for the ${feature}`);
    lists.set(feature, list);
  }
  if (missing.length > 0) throw new Error(`interior style "${style.id}" has ${missing.join(" and ")}`);

  const rng = new DeterministicRng(seed);
  const pick = (feature: Feature): PartDef => {
    const list = lists.get(feature) ?? [];
    return rng.pickWeighted(list, (p) => ruleSet.stats.partFrequencies?.[p.id] || 1) ?? list[0];
  };

  // The plan is centred on the origin: cell (0, 0) is the north-west corner.
  const centreX = (c: number): number => (c - (cols - 1) / 2) * cellM;
  const centreZ = (r: number): number => (r - (rows - 1) / 2) * cellM;

  const out: SynthesizedPlacement[] = [];
  const place = (def: PartDef, target: Vec3Tuple, pos: Vec3Tuple, yaw: number): void => {
    const [sx, sy, sz] = def.bounds.size;
    const scale: Vec3Tuple = [fit(sx, target[0]), fit(sy, target[1]), fit(sz, target[2])];
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    out.push({
      partId: def.id,
      assetRef: def.assetRef,
      category: def.category,
      transform: { pos, rot: [q.x, q.y, q.z, q.w], scale },
      size: [...target],
    });
  };

  for (const cell of floorCells) {
    const floor = pick("floor");
    place(floor, [cellM, floor.bounds.size[1], cellM], [centreX(cell.c), 0, centreZ(cell.r)], 0);
    for (const side of facesOff(cell)) {
      const { c: dc, r: dr } = SIDE_STEP[side];
      const edgeX = centreX(cell.c) + (dc * cellM) / 2;
      const edgeZ = centreZ(cell.r) + (dr * cellM) / 2;
      if (!doorways.has(cellKey(cell, side))) {
        const wall = pick("wall");
        place(wall, [cellM, wallHeightM, wall.bounds.size[2]], [edgeX, wallHeightM / 2, edgeZ], WALL_YAW[side]);
        continue;
      }
      // A doorway: a door fills the opening, with a wall segment either side of it.
      const door = pick("door");
      place(door, [doorwayM, wallHeightM, door.bounds.size[2]], [edgeX, wallHeightM / 2, edgeZ], WALL_YAW[side]);
      if (segM <= 0) continue;
      // The edge runs along x on a north or south side, and along z on an east or west one.
      const alongX = dc === 0;
      for (const sign of [-1, 1]) {
        const offset = sign * (doorwayM / 2 + segM / 2);
        const wall = pick("wall");
        place(
          wall,
          [segM, wallHeightM, wall.bounds.size[2]],
          [edgeX + (alongX ? offset : 0), wallHeightM / 2, edgeZ + (alongX ? 0 : offset)],
          WALL_YAW[side],
        );
      }
    }
  }
  return out;
}
