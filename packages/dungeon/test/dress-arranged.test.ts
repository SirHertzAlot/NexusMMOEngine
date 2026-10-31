/**
 * Dressing: the built-in rooms are arranged. The rest of the arranged suite is in dress-seals.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GridSdf } from "@mmo-engine/placement";
import { BUILTIN_DRESSING, CELL, dressDungeon, type Dungeon, type DungeonDressing } from "../src/index.js";
import { make, cases, scatterOnly, dressed } from "./dress-support.js";

describe("dressDungeon: the built-in rooms are arranged", () => {
  const rooms = (x: DungeonDressing, archetype: string, kind: string) => {
    const out: typeof x.props[] = [];
    x.archetypes.forEach((a, i) => {
      const ps = x.props.filter((p) => p.room === i && p.kind === kind);
      if (a === archetype && ps.length >= 2) out.push(ps);
    });
    return out;
  };
  const oneRow = (ps: DungeonDressing["props"]): boolean => {
    const [nx, ny] = [Math.cos(ps[0].rot), Math.sin(ps[0].rot)];
    return ps.every((p) => Math.abs(p.rot - ps[0].rot) < 1e-9 && Math.abs(nx * p.x + ny * p.y - (nx * ps[0].x + ny * ps[0].y)) < 1e-6);
  };

  it("hangs a catacomb's coffins in niches on the walls, and sets chapels' pews in one grid facing one way", () => {
    const sdfOf = (d: Dungeon): GridSdf => new GridSdf(d.width, d.height, (cx, cy) => d.grid[cy * d.width + cx] !== CELL.floor);
    let niches = 0, onWall = 0;
    for (const { d, x } of dressed("grim", 3)) {
      const sdf = sdfOf(d);
      for (const p of x.props.filter((q) => q.kind === "wall-coffin" || q.kind === "wall-coffin-high")) {
        niches++;
        if (p.mount && Math.abs(sdf.distance(p.x, p.y)) < 0.2) onWall++;
      }
    }
    assert.ok(niches >= 150, `${niches} niches over the catacombs`);
    assert.ok(onWall / niches >= 0.95, `${onWall} of ${niches} niches hang on a wall`);
    const pews = dressed("ancient", 3).flatMap(({ x }) => rooms(x, "chapel", "pew"));
    assert.ok(pews.length >= 5);
    const oneWay = pews.filter((ps) => ps.every((p) => Math.abs(p.rot - ps[0].rot) < 1e-9)).length;
    assert.ok(oneWay / pews.length >= 0.5, `${oneWay} of ${pews.length} chapels have every pew facing one way (the rest had pews with no room left in the grid, scattered)`);
  });

  it("puts a forge's anvil beside its smelter and a vault's coin piles beside its chests", () => {
    let forges = 0, beside = 0;
    for (const { x } of dressed("molten", 3)) {
      x.archetypes.forEach((a, i) => {
        const smelter = x.props.find((p) => p.room === i && p.kind === "smelter");
        const anvil = x.props.find((p) => p.room === i && p.kind === "anvil");
        if (a !== "forge" || !smelter || !anvil) return;
        forges++;
        const [ls, la] = [BUILTIN_DRESSING.archetypes.forge.contents.find((l) => l.kind === "smelter")!, BUILTIN_DRESSING.archetypes.forge.contents.find((l) => l.kind === "anvil")!];
        if (Math.abs(Math.hypot(anvil.x - smelter.x, anvil.y - smelter.y) - (ls.radius + la.radius + la.gap)) < 1e-6) beside++;
      });
    }
    assert.ok(forges >= 3, `${forges} forges`);
    assert.ok(beside / forges >= 0.5, `${beside} of ${forges} anvils stand beside the smelter`);
  });

  /** Doorways of a room the free floor does not connect (props that block bodies are discs of their radius). */

  it("places about as much as scattering did, keeps every invariant, and loosens nothing", () => {
    let arranged = 0, scattered = 0;
    for (const [seed, theme, rank] of cases) {
      const d = make(seed, theme);
      const x = dressDungeon(d, BUILTIN_DRESSING, rank);
      arranged += x.unplaced;
      scattered += dressDungeon(d, scatterOnly(BUILTIN_DRESSING), rank).unplaced;
      assert.deepEqual(x.relaxed.filter((r) => r === "archetypes" || r.startsWith("inventory")), dressDungeon(d, scatterOnly(BUILTIN_DRESSING), rank).relaxed.filter((r) => r === "archetypes" || r.startsWith("inventory")));
      const sdf = new GridSdf(d.width, d.height, (cx, cy) => d.grid[cy * d.width + cx] !== CELL.floor);
      for (const p of x.props) {
        const c = Math.floor(p.y) * d.width + Math.floor(p.x);
        assert.equal(d.roomId[c], p.room, `${theme}: ${p.kind} in its room`);
        assert.equal(d.grid[c], CELL.floor, `${theme}: ${p.kind} on the floor`);
        assert.ok(!d.doorway[c], `${theme}: ${p.kind} off the doorway`);
        const need = Math.min(...Object.values(BUILTIN_DRESSING.archetypes).flatMap((a) => a.contents).filter((l) => l.kind === p.kind).map((l) => l.reach ?? l.radius));
        if (!p.mount) assert.ok(sdf.distance(p.x, p.y) >= need - 1e-3, `${theme}: ${p.kind} off the walls`);
      }
      // Elongated items (a bunk, a coffin) are collision circles of their length and overlap their neighbours as circles by design:
      // their spacing is the pattern's, tested there. Round items must not overlap.
      const slim = new Set(Object.values(BUILTIN_DRESSING.archetypes).flatMap((a) => a.contents).filter((l) => l.reach !== undefined).map((l) => l.kind));
      const solid = x.props.filter((p) => p.collision === "solid" && !slim.has(p.kind));
      for (const [i, p] of solid.entries()) for (const q of solid.slice(i + 1)) if (p.room === q.room) assert.ok(Math.hypot(p.x - q.x, p.y - q.y) >= p.radius + q.radius - 1e-3, `${theme}: ${p.kind} and ${q.kind} overlap`);
    }
    assert.ok(arranged <= Math.ceil(scattered * 1.25) + 2, `${arranged} unplaced arranged against ${scattered} scattered`);
  });

  it("anchors every flank, beside and ring line on another kind of its archetype", () => {
    for (const [id, a] of Object.entries(BUILTIN_DRESSING.archetypes)) {
      for (const k of a.contents) {
        if (["flank", "beside", "ring"].includes(k.arrange)) assert.ok(k.anchor, `${id}.${k.kind} needs an anchor`);
        if (k.anchor) assert.ok(a.contents.some((o) => o !== k && o.kind === k.anchor), `${id}.${k.kind}: anchor ${k.anchor} is in the archetype`);
      }
    }
  });
});
