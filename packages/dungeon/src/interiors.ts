/**
 * Room interiors: each dungeon room's shell laid by the interior grammar, from
 * the room's own footprint. The grammar's walls stand on the edges the
 * dungeon's shell closes, and its openings are the edges the shell leaves
 * open (onto a corridor or another room), so the look and the collision agree.
 *
 * Bake-time only. The placements are stored with the dungeon, and the server
 * spawns them. Positions are metres relative to `origin`, the footprint's
 * centre in the instance's space, where cell (x, y) is centred at (x + 0.5,
 * y + 0.5) cells, as engine-core and the shell have it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  InteriorGrammarSchema,
  InteriorStyleSchema,
  INTERIOR_GRAMMAR_FORMAT,
  placeInterior,
  type InteriorGrammar,
  type InteriorStyle,
  type LearnedRuleSet,
  type SynthesizedPlacement,
} from "@mmo-engine/synthesis";
import { CELL, type Dungeon } from "./generate.js";
import type { Dressing } from "./dressing.js";
import { deriveSeed } from "./rng.js";
import { DUNGEON_CELL, SHELL_DEFAULTS } from "./shell.js";

export interface RoomInterior {
  room: number;
  /** The style it wears (content/synthesis/styles). */
  style: string;
  /** The footprint's centre in the world, metres (x, z). The placements are relative to it. */
  origin: [number, number];
  placements: SynthesizedPlacement[];
}

type Side = "N" | "S" | "E" | "W";
const FACES: Array<[Side, number, number]> = [
  ["N", 0, -1],
  ["S", 0, 1],
  ["W", -1, 0],
  ["E", 1, 0],
];

/** Cells a body walks on. A pool is drawn as floor for now: its basin is the shell's, not the grammar's. */
const walkable = (v: number): boolean => v === CELL.floor || v === CELL.pool;

/**
 * A room's footprint as an interior grammar. Its cells are floor where the
 * room has walkable ground and solid elsewhere in its bounding box. Every edge
 * onto walkable ground outside the room is an opening, the full cell wide, as
 * the shell has it.
 */
export function roomPlan(d: Dungeon, room: number): { grammar: InteriorGrammar; origin: [number, number] } {
  const inRoom = (x: number, y: number): boolean => d.roomId[y * d.width + x] === room;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      if (!inRoom(x, y)) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) throw new Error(`room ${room} has no cells`);
  const size = d.rooms.find((r) => r.id === room)?.size;
  if (!size) throw new Error(`room ${room} is not in the dungeon's room list`);

  const cols = maxX - minX + 1;
  const rows = maxY - minY + 1;
  const plan: string[] = [];
  const doors: Array<{ side: Side; c: number; r: number }> = [];
  for (let r = 0; r < rows; r++) {
    let row = "";
    for (let c = 0; c < cols; c++) {
      const x = minX + c;
      const y = minY + r;
      const floor = inRoom(x, y) && walkable(d.grid[y * d.width + x]);
      row += floor ? "." : "#";
      if (!floor) continue;
      for (const [side, dx, dy] of FACES) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= d.width || ny >= d.height) continue;
        if (walkable(d.grid[ny * d.width + nx]) && !inRoom(nx, ny)) doors.push({ side, c, r });
      }
    }
    plan.push(row);
  }

  const grammar = InteriorGrammarSchema.parse({
    format: INTERIOR_GRAMMAR_FORMAT,
    id: `room-${room}`,
    cellM: DUNGEON_CELL,
    wallHeightM: SHELL_DEFAULTS.roomHeight[size],
    doorwayM: DUNGEON_CELL,
    plan,
    doors,
  });
  // Cell x spans x to x + 1 cells, so the footprint's centre is at (minX + cols / 2) cells.
  const origin: [number, number] = [(minX + cols / 2) * DUNGEON_CELL, (minY + rows / 2) * DUNGEON_CELL];
  return { grammar, origin };
}

/**
 * Lay every room whose archetype names a style. `archetypes` is the dressing's
 * archetype per room ("" where none fits); each room's seed derives from the
 * dungeon's, so rooms differ and a re-bake repeats them.
 */
export function roomInteriors(
  d: Dungeon,
  archetypes: string[],
  dressing: Dressing,
  styles: Record<string, InteriorStyle>,
  ruleSet: LearnedRuleSet,
  seed: number,
): RoomInterior[] {
  const out: RoomInterior[] = [];
  archetypes.forEach((archetype, room) => {
    const style = archetype ? dressing.archetypes[archetype]?.style : undefined;
    if (!style) return;
    const found = styles[style];
    if (!found) throw new Error(`archetype "${archetype}" wears style "${style}", which is not in content/synthesis/styles`);
    const { grammar, origin } = roomPlan(d, room);
    out.push({ room, style, origin, placements: placeInterior(grammar, found, ruleSet, deriveSeed(seed, room)) });
  });
  return out;
}

/** The synthesis content the interiors need: the part rules (dungeon-rules.json) and every style in `dir/styles`. */
export function loadInteriorContent(dir: string): { ruleSet: LearnedRuleSet; styles: Record<string, InteriorStyle> } {
  const ruleSet = JSON.parse(readFileSync(join(dir, "dungeon-rules.json"), "utf8")) as LearnedRuleSet;
  const styles: Record<string, InteriorStyle> = {};
  for (const file of readdirSync(join(dir, "styles"))) {
    if (!file.endsWith(".json")) continue;
    const style = InteriorStyleSchema.parse(JSON.parse(readFileSync(join(dir, "styles", file), "utf8")));
    styles[style.id] = style;
  }
  return { ruleSet, styles };
}
