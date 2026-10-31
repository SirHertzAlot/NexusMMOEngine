/**
 * Dressing: density patterns, and the dense built-in rooms.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GridSdf } from "@mmo-engine/placement";
import { BUILTIN_DRESSING, type Archetype, type Dressing, BUILTIN_THEMES, CELL, dressDungeon, generateDungeon, loadDressing, type Dungeon, type DungeonDressing } from "../src/index.js";
import { make } from "./dress-support.js";

describe("dressDungeon: density patterns", () => {
  type Line = Archetype["contents"][number];
  const room = (contents: Line[], extra: Partial<Archetype> = {}): Dressing => ({
    ...BUILTIN_DRESSING,
    archetypes: { hall: { roles: ["combat", "elite", "treasure", "shrine", "boss", "entrance"], weight: 1, minSize: 8, repeatable: true, avoid: [], near: [], contents, ...extra } },
  });
  const line = (kind: string, where: "floor" | "centre" | "wall" | "corner", radius: number, count: [number, number], extra: Partial<Line> = {}): Line => ({
    kind, where, radius, count, mount: false, minRank: 1, arrange: "scatter", gap: 0.1, ...extra,
  });
  const dressed = (dressing: Dressing, n = 12, theme = "grim") => Array.from({ length: n }, (_, i) => {
    const d = make(i + 1, theme);
    return { d, x: dressDungeon(d, dressing, 3), sdf: new GridSdf(d.width, d.height, (cx, cy) => d.grid[cy * d.width + cx] !== CELL.floor) };
  });

  it("a row of slim, long items stands them `reach` from the wall, side by side", () => {
    const { d, x, sdf } = (() => { const [a] = dressed(room([line("coffin", "wall", 0.2, [14, 14], { arrange: "row", reach: 0.5 })]), 1); return a; })();
    void d;
    const byRoom = new Map<number, typeof x.props>();
    for (const p of x.props) byRoom.set(p.room, [...(byRoom.get(p.room) ?? []), p]);
    const big = [...byRoom.values()].filter((ps) => ps.length >= 10);
    assert.ok(big.length >= 3, `${big.length} rooms hold ten or more coffins`);
    for (const ps of big) {
      const hugging = ps.filter((p) => Math.abs(sdf.distance(p.x, p.y) - 0.5) < 0.16).length;
      assert.ok(hugging / ps.length >= 0.7, `${hugging} of ${ps.length} stand a coffin's length from a wall`);
    }
  });

  it("a line runs down the room's long axis", () => {
    const { x } = dressed(room([line("pillar", "floor", 0.3, [3, 3], { arrange: "line", gap: 1 })]), 1)[0];
    const byRoom = new Map<number, typeof x.props>();
    for (const p of x.props) byRoom.set(p.room, [...(byRoom.get(p.room) ?? []), p]);
    let checked = 0, straight = 0;
    for (const ps of byRoom.values()) {
      if (ps.length < 3) continue;
      checked++;
      if (ps.every((p) => Math.abs(p.y - ps[0].y) < 1e-6) || ps.every((p) => Math.abs(p.x - ps[0].x) < 1e-6)) straight++;
    }
    assert.ok(checked >= 5, `${checked} rooms checked`);
    assert.ok(straight / checked >= 0.6, `${straight} of ${checked} rooms hold their pillars on one straight line (the rest had something in the way and scattered)`);
  });

  it("a `before` line has one item for every item of its anchor, in front of it", () => {
    const dressing = room([
      line("bunk", "wall", 0.5, [4, 8], { arrange: "row", reach: 0.9 }),
      line("footlocker", "floor", 0.3, [0, 1], { arrange: "before", anchor: "bunk", reach: 0.3 }),
    ]);
    let rooms = 0, bunkCount = 0, footCount = 0;
    for (const { x } of dressed(dressing, 8)) {
      const byRoom = new Map<number, typeof x.props>();
      for (const p of x.props) byRoom.set(p.room, [...(byRoom.get(p.room) ?? []), p]);
      for (const ps of byRoom.values()) {
        const bunks = ps.filter((p) => p.kind === "bunk"), foot = ps.filter((p) => p.kind === "footlocker");
        if (bunks.length === 0) continue;
        rooms++;
        assert.ok(foot.length <= bunks.length, `${foot.length} footlockers for ${bunks.length} bunks`);
        bunkCount += bunks.length;
        footCount += foot.length;
        for (const f of foot) {
          const near = bunks.find((b) => Math.abs(Math.hypot(b.x - f.x, b.y - f.y) - (0.9 + 0.3 + 0.1)) < 1e-6 && Math.abs(b.rot - f.rot) < 1e-9);
          assert.ok(near, "a footlocker stands at the foot of a bunk, facing as it does");
        }
      }
    }
    assert.ok(rooms >= 6, `${rooms} rooms with bunks`);
    assert.ok(footCount / bunkCount >= 0.6, `${footCount} footlockers for ${bunkCount} bunks (one is dropped where it would seal a doorway)`);
  });

  it("a mounted row hangs on the wall, never in a doorway", () => {
    const { d, x, sdf } = dressed(room([line("painting", "wall", 0.4, [6, 6], { arrange: "row", mount: true, collision: "none" })]), 1)[0];
    assert.ok(x.props.length >= 12, `${x.props.length} paintings hung`);
    for (const p of x.props) {
      assert.ok(p.mount && p.collision === "none");
      assert.ok(Math.abs(sdf.distance(p.x, p.y)) < 0.2, `on the wall (${sdf.distance(p.x, p.y).toFixed(2)})`);
      assert.ok(!d.doorway[Math.floor(p.y) * d.width + Math.floor(p.x)], "not in a doorway");
    }
  });

  it("`fill` lets a room take more", () => {
    const lines = [line("crate", "floor", 0.45, [0, 20])];
    const total = (fill: number): number => dressed(room(lines, { fill }), 6).reduce((n, { x }) => n + x.props.length, 0);
    assert.ok(total(0.8) > total(0.25) * 1.3, `${total(0.8)} against ${total(0.25)}`);
  });

  it("loadDressing rejects `before` with no anchor and a mounted grid, and accepts a mounted row", () => {
    const dir = mkdtempSync(join(tmpdir(), "density-"));
    const file = (contents: unknown[]): string => {
      const f = join(dir, `d${Math.random()}.json`);
      writeFileSync(f, JSON.stringify({ archetypes: { tomb: { roles: ["combat"], contents } } }));
      return f;
    };
    const base = { kind: "painting", where: "wall", radius: 0.4, count: [1, 4] };
    assert.throws(() => loadDressing(file([{ ...base, kind: "footlocker", where: "floor", arrange: "before" }])), /needs an anchor/);
    assert.throws(() => loadDressing(file([{ ...base, mount: true, arrange: "grid" }])), /mounted line can only be a row/);
    assert.ok(loadDressing(file([{ ...base, mount: true, arrange: "row" }])));
  });
});

describe("dressDungeon: the dense built-in rooms", () => {
  /** A spread of dungeons: every theme, three ranks, six seeds. */
  const spread = (() => {
    const out: { d: Dungeon; x: DungeonDressing; rank: number; theme: string }[] = [];
    for (const theme of Object.keys(BUILTIN_THEMES)) for (let seed = 1; seed <= 6; seed++) for (const rank of [1, 3, 5]) {
      const d = generateDungeon({ seed: seed * 17 + rank, rooms: 34, loopChance: 0.2, decorDensity: 0.5, theme }, BUILTIN_THEMES[theme]);
      out.push({ d, x: dressDungeon(d, BUILTIN_DRESSING, rank), rank, theme });
    }
    return out;
  })();
  /** Every room of an archetype: its props by kind, and its size. */
  const roomsOf = (archetype: string) => spread.flatMap(({ d, x }) => d.rooms.flatMap((r, i) => (x.archetypes[i] === archetype ? [{ r, i, x, props: x.props.filter((p) => p.room === i) }] : [])));
  const count = (props: { kind: string }[], ...kinds: string[]): number => props.filter((p) => kinds.includes(p.kind)).length;
  const share = <T>(xs: T[], ok: (t: T) => boolean): number => xs.filter(ok).length / Math.max(1, xs.length);

  it("a catacomb's walls are lined with coffins in two tiers of niches", () => {
    const crypts = roomsOf("crypt").filter(({ r }) => r.w >= 9 && r.h >= 9);
    assert.ok(crypts.length >= 20, `${crypts.length} catacombs`);
    assert.ok(share(crypts, (c) => count(c.props, "wall-coffin") >= 10) >= 0.7, "ten or more niches on the lower tier");
    assert.ok(share(crypts, (c) => count(c.props, "wall-coffin-high") === count(c.props, "wall-coffin")) >= 0.9, "an upper niche over every lower one");
    assert.ok(share(crypts, (c) => count(c.props, "sarcophagus", "grand-sarcophagus") === 0) === 1, "no sarcophagi: that is the tomb");
  });

  it("a grand tomb is one great sarcophagus in the middle, ringed by statues and candles", () => {
    const tombs = roomsOf("tomb").filter(({ r }) => r.w >= 9 && r.h >= 9);
    assert.ok(tombs.length >= 5, `${tombs.length} tombs`);
    assert.ok(share(tombs, (c) => count(c.props, "grand-sarcophagus") === 1) === 1, "exactly one sarcophagus");
    assert.ok(share(tombs, (c) => count(c.props, "statue") >= 3) >= 0.65, "three or more statues (a doorway or the guard that keeps every door reachable shortens the ring)");
    assert.ok(share(tombs, (c) => count(c.props, "candle-stand") >= 3) >= 0.7, "candle stands round it");
    // The statues ring the sarcophagus: they stand about the same distance from it.
    const ringed = tombs.filter((c) => {
      const s = c.props.find((p) => p.kind === "grand-sarcophagus");
      const ds = c.props.filter((p) => p.kind === "statue").map((p) => Math.hypot(p.x - s!.x, p.y - s!.y));
      return ds.length >= 3 && Math.max(...ds) - Math.min(...ds) < 0.5;
    });
    assert.ok(ringed.length / tombs.length >= 0.6, `${ringed.length} of ${tombs.length} tombs have their statues in a ring`);
  });

  it("a barracks is rows of bunks, a footlocker at the foot of most, and lockers", () => {
    const rooms = roomsOf("barracks").filter(({ r }) => r.w >= 9 && r.h >= 9);
    assert.ok(rooms.length >= 20, `${rooms.length} barracks`);
    assert.ok(share(rooms, (c) => count(c.props, "bunk-bed") >= 6) >= 0.7, "six or more bunks");
    assert.ok(count(rooms.flatMap((c) => c.props), "footlocker") >= 0.6 * count(rooms.flatMap((c) => c.props), "bunk-bed"), "a footlocker for most bunks");
    assert.ok(share(rooms, (c) => count(c.props, "gear-locker") >= 2) >= 0.7, "lockers for the soldiers' gear");
  });

  it("an armoury holds the different arms and armour: sword, spear, bow and shield racks, armour stands", () => {
    const rooms = roomsOf("armoury").filter(({ r }) => r.w >= 8 && r.h >= 8);
    assert.ok(rooms.length >= 15, `${rooms.length} armouries`);
    const kinds = ["sword-rack", "spear-rack", "bow-rack", "shield-rack", "armour-stand"];
    assert.ok(share(rooms, (c) => kinds.filter((k) => count(c.props, k) > 0).length >= 3) >= 0.7, "three or more kinds of rack or stand");
    assert.ok(share(rooms, (c) => count(c.props, "sword-rack", "spear-rack", "bow-rack", "shield-rack", "armour-stand") >= 8) >= 0.6, "eight or more racks and stands");
  });

  it("a library is rows of shelves and tables with benches", () => {
    const rooms = roomsOf("library").filter(({ r }) => r.w >= 9 && r.h >= 9);
    assert.ok(rooms.length >= 8, `${rooms.length} libraries`);
    assert.ok(share(rooms, (c) => count(c.props, "bookshelf", "bookshelf-tall") >= 8) >= 0.7, "eight or more shelves");
    assert.ok(share(rooms, (c) => count(c.props, "reading-table") >= 3) >= 0.7, "reading tables");
    assert.ok(count(rooms.flatMap((c) => c.props), "bench") >= 0.5 * count(rooms.flatMap((c) => c.props), "reading-table"), "a bench for most tables");
  });

  it("a chapel has plenty of pews facing an altar in front of a huge statue, with paintings on the walls", () => {
    const rooms = roomsOf("chapel").filter(({ r }) => r.w >= 9 && r.h >= 9);
    assert.ok(rooms.length >= 20, `${rooms.length} chapels`);
    assert.ok(share(rooms, (c) => count(c.props, "statue-large") === 1 && count(c.props, "altar") === 1) >= 0.8, "a statue and an altar");
    assert.ok(share(rooms, (c) => count(c.props, "pew") >= 6) >= 0.7, "six or more pews");
    assert.ok(share(rooms, (c) => count(c.props, "painting") >= 2) >= 0.6, "paintings");
    // The altar stands in front of the statue, and the pews look toward the altar.
    const facing = rooms.filter((c) => c.props.some((p) => p.kind === "altar"));
    const ok = facing.filter((c) => {
      const altar = c.props.find((p) => p.kind === "altar")!, statue = c.props.find((p) => p.kind === "statue-large")!;
      const front = (altar.x - statue.x) * Math.cos(statue.rot) + (altar.y - statue.y) * Math.sin(statue.rot);
      const pews = c.props.filter((p) => p.kind === "pew");
      return front > 0 && pews.filter((p) => (altar.x - p.x) * Math.cos(p.rot) + (altar.y - p.y) * Math.sin(p.rot) > 0).length >= 0.8 * pews.length;
    });
    assert.ok(ok.length / facing.length >= 0.8, `${ok.length} of ${facing.length} chapels have the altar before the statue and the pews facing it`);
  });

  it("a jail is rows of cells with a guard desk, and a mess hall long tables with benches", () => {
    const jails = roomsOf("jail").filter(({ r }) => r.w >= 9 && r.h >= 9);
    assert.ok(jails.length >= 10, `${jails.length} jails`);
    assert.ok(share(jails, (c) => count(c.props, "jail-cell") >= 6) >= 0.7, "six or more cells");
    const halls = roomsOf("messhall");
    assert.ok(halls.length >= 8, `${halls.length} mess halls`);
    assert.ok(share(halls, (c) => count(c.props, "long-table") >= 3) >= 0.7, "long tables");
  });

  it("every archetype appears somewhere in the spread, and a dungeon stays under the prop ceiling", () => {
    const seen = new Set(spread.flatMap(({ x }) => x.archetypes));
    for (const id of Object.keys(BUILTIN_DRESSING.archetypes)) assert.ok(seen.has(id), `${id} is dressed somewhere`);
    const totals = spread.map(({ x }) => x.props.length).sort((a, b) => a - b);
    assert.ok(totals.at(-1)! <= 1000, `at most ${totals.at(-1)} props in a dungeon (ceiling 1000)`);
    assert.ok(totals[totals.length >> 1] >= 400, `a typical dungeon holds ${totals[totals.length >> 1]} props: dense`);
  });
});
