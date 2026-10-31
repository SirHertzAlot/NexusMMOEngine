/**
 * Dressing: the built-in rooms never seal a doorway more than scattering did.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_DRESSING, BUILTIN_THEMES, CELL, dressDungeon, type Dungeon, type DungeonDressing } from "../src/index.js";
import { scatterOnly, dressed } from "./dress-support.js";

describe("dressDungeon: the built-in rooms are arranged", () => {
  const cutDoorways = (d: Dungeon, x: DungeonDressing): number => {
    let cut = 0;
    d.rooms.forEach((_r, room) => {
      const solid = x.props.filter((p) => p.room === room && !p.mount && p.collision === "solid");
      const open = (cx: number, cy: number): boolean => d.grid[cy * d.width + cx] === CELL.floor && !solid.some((p) => Math.hypot(cx + 0.5 - p.x, cy + 0.5 - p.y) < p.radius);
      const inRoom = (cx: number, cy: number): boolean => d.roomId[cy * d.width + cx] === room;
      const doors: [number, number][] = [];
      for (let cy = 0; cy < d.height; cy++) for (let cx = 0; cx < d.width; cx++) {
        if (!d.doorway[cy * d.width + cx]) continue;
        let touches = false;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if (cx + ox >= 0 && cy + oy >= 0 && cx + ox < d.width && cy + oy < d.height && inRoom(cx + ox, cy + oy)) touches = true;
        if (touches) doors.push([cx, cy]);
      }
      if (doors.length < 2) return;
      const seen = new Set<number>([doors[0][1] * d.width + doors[0][0]]);
      const stack = [doors[0]];
      while (stack.length) {
        const [cx, cy] = stack.pop()!;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const [nx, ny] = [cx + ox, cy + oy];
          const k = ny * d.width + nx;
          if (nx < 0 || ny < 0 || nx >= d.width || ny >= d.height || seen.has(k) || !(inRoom(nx, ny) || d.doorway[k]) || !open(nx, ny)) continue;
          seen.add(k);
          stack.push([nx, ny]);
        }
      }
      for (const [cx, cy] of doors) if (open(cx, cy) && !seen.has(cy * d.width + cx)) cut++;
    });
    return cut;
  };

  it("never seals a room more than scattering did: doorways stay reachable across free floor", () => {
    let arranged = 0, scattered = 0;
    for (const theme of Object.keys(BUILTIN_THEMES)) {
      for (const { d, x } of dressed(theme, 3)) {
        arranged += cutDoorways(d, x);
        scattered += cutDoorways(d, dressDungeon(d, scatterOnly(BUILTIN_DRESSING), 3));
      }
    }
    assert.ok(arranged <= scattered, `${arranged} cut-off doorways arranged against ${scattered} scattered`);
  });
});
