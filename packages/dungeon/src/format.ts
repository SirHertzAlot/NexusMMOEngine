/**
 * Baked dungeon files: a Dungeon as JSON, its grids as base64 (little-endian
 * for the 16-bit ones), with a content hash that identifies the layout: two
 * bakes are the same dungeon exactly when their hashes match.
 *
 *   { format: "mmo-dungeon/1", id, hash, theme, name, seed, params, ...,
 *     grids: { grid, roomId, corridor, doorway, lake, distance } }
 */

import { createHash } from "node:crypto";
import type { Dungeon } from "./generate.js";

export const DUNGEON_FORMAT = "mmo-dungeon/1";

type GridName = "grid" | "roomId" | "corridor" | "doorway" | "lake" | "distance";

export type DungeonFile = Omit<Dungeon, GridName> & {
  format: typeof DUNGEON_FORMAT;
  /** Stable id: `<theme>-<hash prefix>`. */
  id: string;
  /** sha256 of the layout (grids, rooms, corridors, props, spawns, torches). */
  hash: string;
  grids: Record<GridName, string>;
};

const b64 = (a: Uint8Array | Int16Array): string => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");

function fromB64U8(s: string): Uint8Array {
  const b = Buffer.from(s, "base64");
  return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
function fromB64I16(s: string): Int16Array {
  const b = Buffer.from(s, "base64");
  return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/** The layout's content hash (not the seed or parameters: two seeds could make the same dungeon). */
export function layoutHash(d: Dungeon): string {
  const h = createHash("sha256");
  h.update(`${d.width}x${d.height}|${d.params.theme}|`);
  for (const a of [d.grid, d.roomId, d.corridor, d.lake]) h.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  h.update(JSON.stringify([d.rooms, d.corridors, d.props, d.spawns, d.torches]));
  return h.digest("hex");
}

export function encodeDungeon(d: Dungeon): DungeonFile {
  const hash = layoutHash(d);
  const { grid, roomId, corridor, doorway, lake, distance, ...rest } = d;
  return {
    format: DUNGEON_FORMAT,
    id: `${d.params.theme}-${hash.slice(0, 12)}`,
    hash,
    ...rest,
    grids: { grid: b64(grid), roomId: b64(roomId), corridor: b64(corridor), doorway: b64(doorway), lake: b64(lake), distance: b64(distance) },
  };
}

export function decodeDungeon(f: DungeonFile): Dungeon {
  if (f.format !== DUNGEON_FORMAT) throw new Error(`not a ${DUNGEON_FORMAT} file (format: ${String(f.format)})`);
  const { grids, format: _format, id: _id, hash: _hash, ...rest } = f;
  const d: Dungeon = {
    ...rest,
    grid: fromB64U8(grids.grid),
    roomId: fromB64I16(grids.roomId),
    corridor: fromB64U8(grids.corridor),
    doorway: fromB64U8(grids.doorway),
    lake: fromB64U8(grids.lake),
    distance: fromB64I16(grids.distance),
  };
  const cells = d.width * d.height;
  for (const [k, a] of Object.entries({ grid: d.grid, roomId: d.roomId, corridor: d.corridor, doorway: d.doorway, lake: d.lake, distance: d.distance })) {
    if (a.length !== cells) throw new Error(`${k}: ${a.length} cells, expected ${cells}`);
  }
  return d;
}
