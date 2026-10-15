/**
 * What blocks a body in a baked dungeon: dressing says which of its props
 * are solid (`collision`), the bake writes the solid ones (and the layout's
 * pillars, graves, chests) as `colliders`, and nothing is placed to stand
 * inside a wall or a collider: not a spawn point, not a boss.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_DRESSING, BUILTIN_THEMES, CELL, DressingSchema, dressDungeon, encodeDungeon, generateDungeon,
  type Dungeon,
} from "../src/index.js";

const make = (seed: number, theme: string, rooms = 24): Dungeon =>
  generateDungeon({ seed, rooms, loopChance: 0.2, decorDensity: 0.7, theme }, BUILTIN_THEMES[theme]);

const cases: [number, string, number][] = [];
for (const theme of Object.keys(BUILTIN_THEMES)) for (const rank of [1, 3, 5]) for (const k of [0, 1, 2]) cases.push([rank * 101 + theme.length + k * 7919, theme, rank]);

/** A body's radius against props, cells (0.4 m of a 2 m cell). */
const BODY = 0.2;

describe("dressing collision", () => {
  it("every dressed prop says whether it blocks, from its dressing line", () => {
    const lineOf = (arch: string, kind: string) => BUILTIN_DRESSING.archetypes[arch].contents.find((k) => k.kind === kind)!;
    let solid = 0, none = 0;
    for (const [seed, theme, rank] of cases) {
      const d = make(seed, theme);
      const x = dressDungeon(d, BUILTIN_DRESSING, rank);
      for (const p of x.props) {
        const line = lineOf(x.archetypes[p.room], p.kind);
        assert.equal(p.collision, line.collision ?? (line.mount ? "none" : "solid"), `${theme}: ${p.kind}`);
        assert.equal(p.radius, line.radius);
        if (p.collision === "solid") solid++; else none++;
      }
    }
    assert.ok(solid > 0 && none > 0, `both kinds are dressed (${solid} solid, ${none} none)`);
  });

  it("the builtin dressing: statues and chests block, candles and coins do not", () => {
    const all = Object.values(BUILTIN_DRESSING.archetypes).flatMap((a) => a.contents);
    const col = (kind: string) => all.find((k) => k.kind === kind)!.collision;
    for (const kind of ["statue", "chest", "sarcophagus", "crate", "barrel", "bookshelf", "ice-pillar", "throne", "anvil"]) assert.equal(col(kind), "solid", kind);
    for (const kind of ["candles", "coin-pile", "mushrooms", "rubble", "bedroll", "sack"]) assert.equal(col(kind), "none", kind);
  });

  it("a game's dressing file can set it, and a wall-mounted line defaults to none", () => {
    const parsed = DressingSchema.shape.archetypes.parse({
      hall: { roles: ["combat"], contents: [
        { kind: "pillar", where: "floor", radius: 0.4, count: [1, 1] },
        { kind: "banner", where: "wall", radius: 0.3, count: [1, 1], mount: true },
        { kind: "rug", where: "floor", radius: 0.9, count: [1, 1], collision: "none" },
      ] },
    });
    const [pillar, banner, rug] = parsed.hall.contents;
    assert.equal(pillar.collision ?? (pillar.mount ? "none" : "solid"), "solid");
    assert.equal(banner.collision ?? (banner.mount ? "none" : "solid"), "none");
    assert.equal(rug.collision, "none");
    assert.throws(() => DressingSchema.shape.archetypes.parse({ hall: { roles: ["combat"], contents: [{ kind: "x", where: "floor", radius: 1, count: [1, 1], collision: "maybe" }] } }));
  });
});

describe("baked colliders", () => {
  const d = make(4242, "grim", 30);
  const dressing = dressDungeon(d, BUILTIN_DRESSING, 3);
  const f = encodeDungeon(d, dressing);

  it("hold the layout's pillars and the solid dressing, and not the torches or the flat props", () => {
    const solidDressed = dressing.props.filter((p) => p.collision === "solid").length;
    const layoutSolid = d.props.filter((p) => ["pillar", "grave", "sarcophagus", "chest", "bossCrystal", "shrineCrystal", "brazier"].includes(p.kind)).length;
    assert.ok(layoutSolid > 0 && solidDressed > 0);
    assert.equal(f.colliders.length, layoutSolid + solidDressed);
    const flat = d.props.filter((p) => ["debris", "moss", "bones", "crack", "banner", "ring", "candle"].includes(p.kind)).length;
    assert.ok(flat > 0, "the layout has props that must not block");
    assert.equal(f.colliders.filter((c) => c.r <= 0).length, 0);
  });

  it("an undressed bake still blocks on the layout's pillars", () => {
    assert.ok(encodeDungeon(d).colliders.length > 0);
  });
});

describe("placements", () => {
  it("no spawn point or boss stands in rock or in a collider", () => {
    let checked = 0, bosses = 0;
    for (const [seed, theme, rank] of cases) {
      const d = make(seed, theme, 30);
      if (!d.valid) continue;
      const f = encodeDungeon(d, dressDungeon(d, BUILTIN_DRESSING, rank));
      for (const s of d.spawns) {
        assert.equal(d.grid[s.y * d.width + s.x], CELL.floor, `${theme} ${seed}: spawn ${s.x},${s.y} on the floor`);
        for (const c of f.colliders) {
          const dist = Math.hypot(s.x + 0.5 - c.x, s.y + 0.5 - c.y);
          assert.ok(dist >= c.r + BODY, `${theme} ${seed}: spawn ${s.x},${s.y} (room ${s.room}) is ${dist.toFixed(2)} cells from a collider of ${c.r}`);
        }
        checked++;
        if (s.room === d.boss) bosses++;
      }
      // The entrance, where players land, is clear too.
      const e = d.rooms[d.entrance];
      for (const c of f.colliders) assert.ok(Math.hypot(Math.round(e.cx) + 0.5 - c.x, Math.round(e.cy) + 0.5 - c.y) >= c.r + BODY, `${theme} ${seed}: entrance clear`);
    }
    assert.ok(checked > 100 && bosses > 10, `${checked} spawns, ${bosses} in boss rooms`);
  });
});
