/**
 * Dressing: WFC's choices (archetypes by role, theme, size and rank; the
 * rules between neighbours; inventories within their counts; veins by rank
 * and depth, one seam kind across neighbours) and where scatter and the
 * raymarcher put things (in the room, clear, against walls where asked).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GridSdf } from "@mmo-engine/placement";
import {
  bakeDungeons, BUILTIN_DRESSING, type Archetype, type Dressing, BUILTIN_THEMES, CELL, dressDungeon, generateDungeon, loadDressing, readIndex,
  type Dungeon, type DungeonDressing, type DungeonFile,
} from "../src/index.js";

const make = (seed: number, theme: string, rooms = 34): Dungeon =>
  generateDungeon({ seed, rooms, loopChance: 0.2, decorDensity: 0.5, theme }, BUILTIN_THEMES[theme]);

const cases: [number, string, number][] = [];
for (const theme of Object.keys(BUILTIN_THEMES)) for (const rank of [1, 3, 5]) cases.push([rank * 101 + theme.length, theme, rank]);

describe("dressDungeon: what (WFC)", () => {
  it("is deterministic", () => {
    const d = make(9, "grim");
    assert.deepEqual(dressDungeon(d, BUILTIN_DRESSING, 3), dressDungeon(d, BUILTIN_DRESSING, 3));
    assert.notDeepEqual(dressDungeon(d, BUILTIN_DRESSING, 3, 1).props, dressDungeon(d, BUILTIN_DRESSING, 3, 2).props);
  });

  it("gives each room an archetype that fits it, and keeps the rules between neighbours", () => {
    for (const [seed, theme, rank] of cases) {
      const d = make(seed, theme);
      const x = dressDungeon(d, BUILTIN_DRESSING, rank);
      const at = `${theme} rank ${rank}`;
      assert.ok(!x.relaxed.includes("archetypes"), `${at}: no rule had to be loosened`);
      const tally = new Map<string, number>();
      d.rooms.forEach((r, i) => {
        const id = x.archetypes[i];
        assert.ok(id, `${at}: room ${i} (${r.type}) has an archetype`);
        const a = BUILTIN_DRESSING.archetypes[id];
        assert.ok(a.roles.includes(r.type), `${at}: ${id} suits a ${r.type} room`);
        assert.ok(!a.themes || a.themes.includes(theme), `${at}: ${id} belongs to ${theme}`);
        assert.ok(Math.min(r.w, r.h) >= a.minSize, `${at}: ${id} fits room ${i}`);
        tally.set(id, (tally.get(id) ?? 0) + 1);
      });
      for (const [id, n] of tally) {
        const max = BUILTIN_DRESSING.archetypes[id].max;
        if (max !== undefined) assert.ok(n <= max, `${at}: at most ${max} ${id}`);
      }
      const neighbours = d.rooms.map(() => new Set<number>());
      for (const e of d.corridors) {
        neighbours[e.a].add(e.b);
        neighbours[e.b].add(e.a);
        const [p, q] = [x.archetypes[e.a], x.archetypes[e.b]];
        const ap = BUILTIN_DRESSING.archetypes[p], aq = BUILTIN_DRESSING.archetypes[q];
        if (p === q) assert.ok(ap.repeatable, `${at}: two ${p} side by side`);
        assert.ok(!ap.avoid.includes(q) && !aq.avoid.includes(p), `${at}: ${p} beside ${q}`);
      }
      d.rooms.forEach((_, i) => {
        const a = BUILTIN_DRESSING.archetypes[x.archetypes[i]];
        if (a.near.length) assert.ok([...neighbours[i]].some((j) => a.near.includes(x.archetypes[j])), `${at}: ${x.archetypes[i]} has a ${a.near.join("/")} beside it`);
      });
    }
  });

  it("fills rooms within their inventory counts, and gates veins by rank and depth", () => {
    for (const [seed, theme, rank] of cases) {
      const d = make(seed, theme);
      const x = dressDungeon(d, BUILTIN_DRESSING, rank);
      const at = `${theme} rank ${rank}`;
      d.rooms.forEach((_, i) => {
        const a = BUILTIN_DRESSING.archetypes[x.archetypes[i]];
        for (const line of a.contents) {
          const n = x.props.filter((p) => p.room === i && p.kind === line.kind).length;
          const max = a.contents.filter((l) => l.kind === line.kind && rank >= l.minRank).reduce((s, l) => s + l.count[1], 0);
          assert.ok(n <= max, `${at}: room ${i} has ${n} ${line.kind} (max ${max})`);
          if (rank < line.minRank) assert.ok(a.contents.some((l) => l.kind === line.kind && rank >= l.minRank) || n === 0, `${at}: no ${line.kind} below rank ${line.minRank}`);
        }
      });
      for (const v of x.resources) {
        const vein = BUILTIN_DRESSING.veins[v.kind];
        assert.ok(rank >= vein.minRank, `${at}: ${v.kind} needs rank ${vein.minRank}`);
        assert.ok(d.rooms[v.room].difficulty >= vein.minDepth, `${at}: ${v.kind} lies deep enough`);
        assert.equal(v.tier, vein.tier);
        assert.equal(x.seams[v.room], v.kind);
      }
      for (const e of d.corridors) {
        const [p, q] = [x.seams[e.a], x.seams[e.b]];
        assert.ok(!p || !q || p === q, `${at}: one seam kind across neighbours (${p} / ${q})`);
      }
      assert.equal(x.seams[d.entrance], "", "no veins in the entrance");
    }
    // Higher ranks carry more (and richer) veins.
    const d = make(77, "ancient", 40);
    const low = dressDungeon(d, BUILTIN_DRESSING, 1), high = dressDungeon(d, BUILTIN_DRESSING, 5);
    assert.ok(high.resources.length > low.resources.length, `${low.resources.length} veins at rank 1, ${high.resources.length} at 5`);
    assert.ok(Math.max(...high.resources.map((v) => v.tier)) > Math.max(1, ...low.resources.map((v) => v.tier)));
  });
});

describe("dressDungeon: where (scatter + raymarcher)", () => {
  const check = (d: Dungeon, x: DungeonDressing, at: string): void => {
    const sdf = new GridSdf(d.width, d.height, (cx, cy) => d.grid[cy * d.width + cx] !== CELL.floor);
    for (const p of x.props) {
      const c = Math.floor(p.y) * d.width + Math.floor(p.x);
      assert.equal(d.roomId[c], p.room, `${at}: ${p.kind} in its room`);
      assert.equal(d.grid[c], CELL.floor, `${at}: ${p.kind} on the floor`);
      assert.ok(!d.doorway[c], `${at}: ${p.kind} off the doorway`);
      const line = Object.values(BUILTIN_DRESSING.archetypes).flatMap((a) => a.contents).find((l) => l.kind === p.kind)!;
      if (!p.mount) assert.ok(sdf.distance(p.x, p.y) >= line.radius - 1e-3, `${at}: ${p.kind} has clearance`);
    }
    for (const v of x.resources) assert.ok(Math.abs(sdf.distance(v.x, v.y)) < 0.05, `${at}: ${v.kind} on a wall surface`);
    // Nothing overlaps what the layout already put in the room (its set pieces, the monsters).
    for (const s of d.spawns) for (const p of x.props.filter((q) => q.room === s.room && !q.mount)) assert.ok(Math.hypot(p.x - s.x - 0.5, p.y - s.y - 0.5) > 0.5, `${at}: ${p.kind} clear of a spawn`);
  };

  it("puts everything in its room, on the floor or a wall, clear of doorways, spawns and walls", () => {
    for (const [seed, theme, rank] of cases.slice(0, 8)) {
      const d = make(seed, theme);
      check(d, dressDungeon(d, BUILTIN_DRESSING, rank), `${theme} rank ${rank}`);
    }
  });

  it("clusters a seam's veins together", () => {
    const d = make(123, "molten", 40);
    const x = dressDungeon(d, BUILTIN_DRESSING, 5);
    const byRoom = new Map<number, typeof x.resources>();
    for (const v of x.resources) byRoom.set(v.room, [...(byRoom.get(v.room) ?? []), v]);
    assert.ok(byRoom.size > 0);
    for (const vs of byRoom.values()) for (const v of vs) assert.ok(Math.hypot(v.x - vs[0].x, v.y - vs[0].y) <= 3.6, "within a seam's reach of its first vein");
  });
});

/** The dressing with every line scattered: what dressing did before arrangements. */
const scatterOnly = (d: Dressing): Dressing => ({
  ...d,
  archetypes: Object.fromEntries(Object.entries(d.archetypes).map(([id, a]) => [id, { ...a, contents: a.contents.map((k) => ({ ...k, arrange: "scatter" as const })) }])),
});
const digest = (x: DungeonDressing): string => createHash("sha256").update(JSON.stringify(x.props)).digest("hex").slice(0, 16);

describe("dressDungeon: arrangements", () => {
  it("scatter-only dressing dresses exactly as it did before arrangements", () => {
    // Pinned from the code before arrangements existed (cases 0, 4, 8, 13).
    const pinned: [number, string] = [0, "f16ebb1997b93baa"];
    const all: [number, string][] = [[0, "f16ebb1997b93baa"], [4, "ad28c2390f5f488e"], [8, "28671070cff1032b"], [13, "371f1c5aa448d239"]];
    assert.ok(pinned);
    for (const [i, hash] of all) {
      const [seed, theme, rank] = cases[i];
      assert.equal(digest(dressDungeon(make(seed, theme), scatterOnly(BUILTIN_DRESSING), rank)), hash, `case ${i} (${theme} rank ${rank})`);
    }
  });

  const tomb = (contents: Archetype["contents"]): Dressing => ({
    ...BUILTIN_DRESSING,
    archetypes: { tomb: { roles: ["combat", "elite", "treasure", "shrine", "boss", "entrance"], weight: 1, minSize: 6, repeatable: true, avoid: [], near: [], contents } },
  });
  const line = (kind: string, where: "floor" | "centre" | "wall" | "corner", radius: number, count: [number, number], extra: Partial<Archetype["contents"][number]> = {}): Archetype["contents"][number] => ({
    kind, where, radius, count, mount: false, minRank: 1, arrange: "scatter", gap: 0.3, ...extra,
  });

  it("lays a row line along a wall: evenly spaced and straight in straight-walled rooms, hugging the wall in all", () => {
    const dressing = tomb([line("coffin", "wall", 0.6, [3, 3], { arrange: "row", collision: "solid" })]);
    let three = 0, hugging = 0, rectRooms = 0, rows = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const d = make(seed, "grim");
      const sdf = new GridSdf(d.width, d.height, (cx, cy) => d.grid[cy * d.width + cx] !== CELL.floor);
      const x = dressDungeon(d, dressing, 1);
      for (const [room, r] of d.rooms.entries()) {
        const ps = x.props.filter((p) => p.room === room);
        if (ps.length !== 3) continue;
        three++;
        if (ps.every((p) => Math.abs(sdf.distance(p.x, p.y) - 0.6) < 0.16)) hugging++;
        if (r.shape !== "rect") continue;
        rectRooms++;
        const [nx, ny] = [Math.cos(ps[0].rot), Math.sin(ps[0].rot)];
        const along = ps.map((p) => -ny * p.x + nx * p.y).sort((a, b) => a - b);
        const flat = ps.every((p) => Math.abs(nx * p.x + ny * p.y - (nx * ps[0].x + ny * ps[0].y)) < 1e-6 && Math.abs(p.rot - ps[0].rot) < 1e-9);
        if (flat && Math.abs(along[1] - along[0] - 1.5) < 1e-6 && Math.abs(along[2] - along[1] - 1.5) < 1e-6) rows++;
      }
    }
    assert.ok(three >= 100 && rectRooms >= 50, `${three} rooms placed all three (${rectRooms} rectangular)`);
    assert.ok(hugging / three >= 0.85, `${hugging} of ${three} keep to the wall`);
    // The rest of the rectangular rooms have pillars, doors or set pieces on their walls: the row is cut short and the rest scatter.
    assert.ok(rows / rectRooms >= 0.5, `${rows} of ${rectRooms} rectangular rooms hold one even straight row`);
  });

  it("scatters a line whose anchor the room never placed, without failing", () => {
    const dressing = tomb([line("candles", "corner", 0.3, [2, 2], { arrange: "ring", anchor: "altar" }), line("altar", "centre", 0.8, [0, 0])]);
    const d = make(5, "grim");
    const x = dressDungeon(d, dressing, 1);
    assert.ok(x.props.some((p) => p.kind === "candles"), "the candles are placed anyway");
    assert.ok(x.props.every((p) => p.kind !== "altar"));
    assert.ok(!x.relaxed.includes("archetypes"));
  });

  it("flanks and rings stand round what they are anchored on", () => {
    const dressing = tomb([line("throne", "wall", 1, [1, 1]), line("statue", "floor", 0.5, [2, 2], { arrange: "flank", anchor: "throne" }), line("candles", "floor", 0.3, [4, 4], { arrange: "ring", anchor: "statue" })]);
    let flanked = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const x = dressDungeon(make(seed, "ancient"), dressing, 1);
      for (const t of x.props.filter((p) => p.kind === "throne")) {
        const sts = x.props.filter((p) => p.kind === "statue" && p.room === t.room);
        if (sts.length === 2 && sts.every((s) => Math.abs(Math.hypot(s.x - t.x, s.y - t.y) - 1.8) < 1e-6 && Math.abs(s.rot - t.rot) < 1e-9)) flanked++;
      }
    }
    assert.ok(flanked >= 3, `${flanked} thrones flanked by a pair`);
  });
});

describe("dressDungeon: the built-in rooms are arranged", () => {
  const seeds = Array.from({ length: 24 }, (_, i) => i + 1);
  const dressed = (theme: string, rank: number, dressing: Dressing = BUILTIN_DRESSING) => seeds.map((seed) => {
    const d = make(seed, theme);
    return { d, x: dressDungeon(d, dressing, rank) };
  });
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

  it("sets crypts' coffins and armouries' racks in rows, and chapels' pews in one grid facing one way", () => {
    for (const [theme, archetype, kind] of [["grim", "crypt", "coffin"], ["grim", "armoury", "weapon-rack"]] as const) {
      const sets = dressed(theme, 3).flatMap(({ x }) => rooms(x, archetype, kind));
      assert.ok(sets.length >= 5, `${theme}: ${sets.length} ${archetype} rooms with two or more ${kind}s`);
      const rows = sets.filter(oneRow).length;
      assert.ok(rows / sets.length >= 0.4, `${rows} of ${sets.length} ${archetype} rooms hold their ${kind}s in one row`);
    }
    const pews = dressed("ancient", 3).flatMap(({ x }) => rooms(x, "chapel", "pew"));
    assert.ok(pews.length >= 5);
    assert.ok(pews.filter((ps) => ps.every((p) => Math.abs(p.rot - ps[0].rot) < 1e-9)).length / pews.length >= 0.8, "pews face one way");
  });

  it("puts a forge's anvil beside its smelter and a vault's coin piles beside its chests", () => {
    let forges = 0, beside = 0;
    for (const { x } of dressed("molten", 3)) {
      x.archetypes.forEach((a, i) => {
        const smelter = x.props.find((p) => p.room === i && p.kind === "smelter");
        const anvil = x.props.find((p) => p.room === i && p.kind === "anvil");
        if (a !== "forge" || !smelter || !anvil) return;
        forges++;
        if (Math.abs(Math.hypot(anvil.x - smelter.x, anvil.y - smelter.y) - (0.9 + 0.7 + 0.3)) < 1e-6) beside++;
      });
    }
    assert.ok(forges >= 3, `${forges} forges`);
    assert.ok(beside / forges >= 0.5, `${beside} of ${forges} anvils stand beside the smelter`);
  });

  /** Doorways of a room the free floor does not connect (props that block bodies are discs of their radius). */
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
        if (!p.mount) assert.ok(sdf.distance(p.x, p.y) >= p.radius - 1e-3, `${theme}: ${p.kind} off the walls`);
      }
      const solid = x.props.filter((p) => p.collision === "solid");
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

describe("dressing data and the bake", () => {
  it("merges a game's dressing over ours, reporting every problem", () => {
    const dir = mkdtempSync(join(tmpdir(), "dressing-"));
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ archetypes: { kennel: { roles: ["combat"], contents: [{ kind: "cage", where: "wall", radius: 0.5, count: [1, 2] }] } }, veinRooms: 0.9 }));
    const g = loadDressing(good);
    assert.ok(g.archetypes.kennel && g.archetypes.crypt);
    assert.equal(g.veinRooms, 0.9);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ archetypes: { kennel: { roles: ["combat"], near: ["zoo"], contents: [{ kind: "cage", where: "wall", radius: 0.5, count: [3, 1] }] } } }));
    assert.throws(() => loadDressing(bad), (e: Error) => /no archetype "zoo"/.test(e.message) && /count min above max/.test(e.message));
  });

  it("reads arrangements on content lines, and rejects the ones that cannot work", () => {
    const dir = mkdtempSync(join(tmpdir(), "arrange-"));
    const withLines = (contents: unknown[]): string => {
      const f = join(dir, `a${Math.random()}.json`);
      writeFileSync(f, JSON.stringify({ archetypes: { tomb: { roles: ["combat"], contents } } }));
      return f;
    };
    const line = { kind: "coffin", where: "wall", radius: 0.6, count: [1, 3] };
    const ok = loadDressing(withLines([{ ...line, arrange: "row" }, { kind: "urn", where: "corner", radius: 0.3, count: [1, 2] }]));
    assert.equal(ok.archetypes.tomb.contents[0].arrange, "row");
    assert.equal(ok.archetypes.tomb.contents[0].gap, 0.3);
    assert.equal(ok.archetypes.tomb.contents[1].arrange, "scatter", "a line that names none scatters, as before");
    assert.throws(() => loadDressing(withLines([{ ...line, arrange: "zigzag" }])), /archetypes\.tomb\.contents\.0\.arrange/);
    assert.throws(() => loadDressing(withLines([{ ...line, arrange: "flank" }])), /needs an anchor/);
    assert.throws(() => loadDressing(withLines([{ ...line, arrange: "flank", anchor: "throne" }])), /anchor "throne"/);
    assert.ok(loadDressing(withLines([{ ...line, arrange: "flank", anchor: "urn" }, { kind: "urn", where: "centre", radius: 0.3, count: [1, 1] }])));
    for (const a of Object.values(BUILTIN_DRESSING.archetypes)) for (const k of a.contents) assert.ok(k.arrange, `${k.kind} has an arrangement`);
  });

  it("rebaking changes the dressing only: the same seed gives the same rooms, doorways, spawns and shell", () => {
    const common = { count: 3, seed: 7, theme: "auto", rooms: [14, 24] as [number, number], loopChance: 0.15, decorDensity: 0.5, themes: BUILTIN_THEMES };
    const a = mkdtempSync(join(tmpdir(), "arranged-"));
    const b = mkdtempSync(join(tmpdir(), "scattered-"));
    bakeDungeons({ ...common, out: a, dress: { dressing: BUILTIN_DRESSING, rank: [2, 4] } });
    bakeDungeons({ ...common, out: b, dress: { dressing: scatterOnly(BUILTIN_DRESSING), rank: [2, 4] } });
    const ea = readIndex(a).dungeons, eb = readIndex(b).dungeons;
    assert.equal(ea.length, eb.length);
    ea.forEach((x, i) => {
      const fa = JSON.parse(readFileSync(join(a, x.file), "utf8")) as Record<string, unknown>;
      const fb = JSON.parse(readFileSync(join(b, eb[i].file), "utf8")) as Record<string, unknown>;
      for (const key of ["seed", "params", "width", "height", "rooms", "corridors", "entrance", "boss", "grids", "spawns", "torches", "pools", "arches", "props"]) {
        assert.deepEqual(fa[key], fb[key], `dungeon ${i}: ${key} is the same`);
      }
      assert.deepEqual((fa.dressing as DungeonDressing).archetypes, (fb.dressing as DungeonDressing).archetypes, "the same rooms hold the same archetypes");
      if (x.shell) assert.ok(readFileSync(join(a, x.shell.file)).equals(readFileSync(join(b, eb[i].shell!.file))), `dungeon ${i}: the shell is the same`);
    });
  });

  it("dresses baked dungeons at a rank in range, or leaves them bare", () => {
    const out = mkdtempSync(join(tmpdir(), "dressed-"));
    const common = { count: 4, seed: 3, theme: "auto", rooms: [14, 24] as [number, number], loopChance: 0.15, decorDensity: 0.5, themes: BUILTIN_THEMES, out };
    bakeDungeons({ ...common, dress: { dressing: BUILTIN_DRESSING, rank: [2, 4] } });
    for (const e of readIndex(out).dungeons) {
      assert.ok(e.rank! >= 2 && e.rank! <= 4);
      const f = JSON.parse(readFileSync(join(out, e.file), "utf8")) as DungeonFile;
      assert.equal(f.dressing?.rank, e.rank);
      assert.equal(f.dressing?.resources.length, e.veins);
    }
    const bare = mkdtempSync(join(tmpdir(), "bare-"));
    bakeDungeons({ ...common, out: bare });
    const e = readIndex(bare).dungeons[0];
    assert.equal(e.rank, undefined);
    assert.equal((JSON.parse(readFileSync(join(bare, e.file), "utf8")) as DungeonFile).dressing, undefined);
  });
});
