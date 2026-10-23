/**
 * ASCII rendering of a settlement — the bake-time debugging view, and
 * the frame source for the PNG/GIF exports used in testing.
 *
 *   ~ water    , marsh    . land    = road    * lilia (stake pits)
 *   # wall     G gate     B barbican
 *   T square tower       O round tower
 *   K core (keep)        W internal well     R granary
 */

import { idx, tx, ty, type Settlement } from "./model.js";

export function renderAscii(s: Settlement): string {
  const g = s.grid;
  const towerAt = new Map(s.towers.map((t) => [idx(g, t.x, t.y), t.form]));
  // Interior store markers, flanking the core.
  const markers = new Map<number, string>();
  const cx = tx(g, s.core);
  const cy = ty(g, s.core);
  if (s.stores.well) markers.set(idx(g, cx - 3, cy), "W");
  if (s.stores.granary) markers.set(idx(g, cx + 3, cy), "R");
  const rows: string[] = [];
  for (let y = 0; y < g.h; y++) {
    let row = "";
    for (let x = 0; x < g.w; x++) {
      const i = idx(g, x, y);
      let ch: string;
      if (i === s.core) ch = "K";
      else if (i === s.barbican) ch = "B";
      else if (i === s.gate) ch = "G";
      else if (towerAt.has(i)) ch = towerAt.get(i) === "round" ? "O" : "T";
      else if (s.walls.has(i)) ch = "#";
      else if (markers.has(i)) ch = markers.get(i)!;
      else if (s.obstacles.has(i)) ch = "*";
      else {
        switch (g.tiles[i].terrain) {
          case "water":
            ch = "~";
            break;
          case "marsh":
            ch = ",";
            break;
          case "road":
            ch = "=";
            break;
          case "land":
            ch = ".";
            break;
        }
      }
      row += ch;
    }
    rows.push(row);
  }
  return rows.join("\n");
}

/** Per-tile colour classes for image export: one char class per tile. */
export function renderClasses(s: Settlement): string[] {
  return renderAscii(s).split("\n");
}
