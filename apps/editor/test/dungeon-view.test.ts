import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CELL, countEdits, dungeonView, editPatch, emptyPatch, validatePatch, type DungeonFileView } from "../src/inspectors/dungeon-view.js";
import { bakeArgs, listPool, readDungeon, savePatch } from "../src/dungeon-host.js";

// A tiny 8×4 dungeon: walls around two 3×2 rooms joined at x 4.
//   ########
//   #...#..#   room 0 (entrance) x 1–3, room 1 (boss) x 5–6
//   #.......
//   ########
const W = 8;
const H = 4;
const rows = ["########", "#...#..#", "#.......", "########"];
function synthetic(): DungeonFileView {
  const grid = new Uint8Array(W * H);
  const room = new Int16Array(W * H).fill(-1);
  rows.forEach((r, y) =>
    [...r].forEach((c, x) => {
      grid[y * W + x] = c === "#" ? CELL.wall : CELL.floor;
      if (c === ".") room[y * W + x] = x < 4 ? 0 : x > 4 ? 1 : -1;
    }),
  );
  return {
    format: "mmo-dungeon/1",
    id: "crypt-0123456789ab",
    hash: "h1",
    name: "Test Crypt",
    width: W,
    height: H,
    params: { theme: "crypt" },
    rooms: [
      { id: 0, cx: 2, cy: 1, w: 3, h: 2, type: "entrance", depth: 0, difficulty: 0, size: "small", shape: "rect" },
      { id: 1, cx: 5, cy: 1, w: 2, h: 2, type: "boss", depth: 1, difficulty: 1, size: "small", shape: "rect" },
    ],
    corridors: [{ a: 0, b: 1, loop: false, critical: true }],
    props: [{ kind: "pillar", x: 2, y: 1, rot: 0, room: 0 }],
    spawns: [
      { x: 2, y: 2, tier: 1, room: 0 },
      { x: 6, y: 2, tier: 3, room: 1 },
    ],
    torches: [{ x: 1, y: 0, dx: 0, dy: 1 }],
    entrance: 0,
    boss: 1,
    grids: { grid: Buffer.from(grid).toString("base64"), roomId: Buffer.from(new Uint8Array(room.buffer)).toString("base64") },
    dressing: { rank: 2, archetypes: ["barracks", "throne"], props: [{ kind: "crate", x: 5.4, y: 1.6, rot: 1, room: 1, mount: false }] },
    population: { rooms: ["skeleton", "lich"], spawns: [{ x: 2, y: 2, tier: 1, room: 0, species: "skeleton" }, { x: 6, y: 2, tier: 3, room: 1, species: "lich" }] },
  };
}

test("the view applies nothing for an empty patch, with layout props centred on their cell", () => {
  const d = synthetic();
  const v = dungeonView(d, emptyPatch(d));
  assert.equal(v.edits, 0);
  assert.deepEqual(v.rooms.map((r) => [r.type, r.archetype, r.species]), [["entrance", "barracks", "skeleton"], ["boss", "throne", "lich"]]);
  assert.deepEqual(v.props.map((p) => [p.key, p.x, p.y]), [["p0", 2.5, 1.5], ["d0", 5.4, 1.6]]);
  assert.equal(v.roomId[1 * W + 2], 0);
  assert.equal(v.roomId[2 * W + 4], -1);
  assert.equal(v.spawns[1].rank, 2);
  assert.deepEqual(validatePatch(d, emptyPatch(d)), []);
});

test("edits land in the patch, and setting a value back to the bake drops it", () => {
  const d = synthetic();
  let p = emptyPatch(d);
  p = editPatch(d, p, { kind: "roomArchetype", room: 1, archetype: "barracks" });
  p = editPatch(d, p, { kind: "spawn", index: 1, pinned: true, rank: 4 });
  p = editPatch(d, p, { kind: "moveProp", key: "p0", x: 3.5, y: 2.5 });
  p = editPatch(d, p, { kind: "removeProp", key: "d0" });
  p = editPatch(d, p, { kind: "addProp", prop: { kind: "crate", x: 6.25, y: 1.5, rot: 0 } });
  assert.equal(countEdits(p), 5);
  assert.deepEqual(p.props.p0, { x: 3, y: 2 }, "layout props are stored in whole-cell units");
  const v = dungeonView(d, p);
  assert.equal(v.rooms[1].archetype, "barracks");
  assert.ok(v.rooms[1].edited);
  assert.deepEqual([v.spawns[1].pinned, v.spawns[1].rank], [true, 4]);
  assert.deepEqual(v.props.map((x) => [x.key, x.x, x.y]), [["p0", 3.5, 2.5], ["a0", 6.25, 1.5]]);
  assert.deepEqual(validatePatch(d, p, ["barracks", "throne"]), []);

  p = editPatch(d, p, { kind: "roomArchetype", room: 1, archetype: "throne" });
  p = editPatch(d, p, { kind: "spawn", index: 1, pinned: false, rank: 2 });
  assert.deepEqual([p.rooms, p.spawns], [{}, {}]);
  p = editPatch(d, p, { kind: "removeProp", key: "a0" });
  assert.equal(p.added.length, 0);
});

test("the patch is checked against the layout before it is saved", () => {
  const d = synthetic();
  const stale = { ...emptyPatch(d), hash: "other" };
  assert.match(validatePatch(d, stale)[0].message, /stale/);
  let p = editPatch(d, emptyPatch(d), { kind: "roomType", room: 1, type: "combat" });
  assert.ok(validatePatch(d, p).some((i) => /exactly one boss/.test(i.message)));
  p = editPatch(d, emptyPatch(d), { kind: "moveProp", key: "d0", x: 4.5, y: 1.5 });
  assert.ok(validatePatch(d, p).some((i) => i.path === "props.d0" && /floor/.test(i.message)), "x 4 row 1 is a wall");
  p = { ...emptyPatch(d), spawns: { "1": { rank: 9 } }, props: { p7: { removed: true } } };
  const paths = validatePatch(d, p).map((i) => i.path);
  assert.ok(paths.includes("spawns.1.rank"));
  assert.ok(paths.includes("props.p7"));
  assert.ok(validatePatch(d, editPatch(d, emptyPatch(d), { kind: "roomArchetype", room: 0, archetype: "nope" }), ["barracks"]).length > 0);
});

test("the host lists the pool, saves a valid patch, refuses a bad one and removes an empty one", () => {
  const data = mkdtempSync(join(tmpdir(), "dungeon-pool-"));
  const dir = join(data, "dungeons");
  const d = synthetic();
  mkdirSync(dir);
  writeFileSync(join(dir, `${d.id}.dungeon.json`), JSON.stringify(d));
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify({ dungeons: [{ id: d.id, file: `${d.id}.dungeon.json`, hash: d.hash, name: d.name, theme: "crypt", rooms: 2, rank: 2, boss: "lich", floorTiles: 11, width: W, height: H }] }),
  );
  assert.deepEqual(listPool(data).map((e) => [e.id, e.map, e.edits, e.stale]), [[d.id, false, 0, false]]);
  assert.throws(() => readDungeon(data, "../../etc-0123456789ab"), /no dungeon/);
  assert.throws(() => readDungeon(data, "crypt-ffffffffffff"), /no dungeon/);

  const patch = editPatch(d, emptyPatch(d), { kind: "spawn", index: 0, pinned: true });
  assert.deepEqual(savePatch(data, d.id, patch), { edits: 1 });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, `${d.id}.patch.json`), "utf8")), patch);
  assert.equal(listPool(data)[0].edits, 1);
  assert.deepEqual(readDungeon(data, d.id).patch, patch);

  const bad = editPatch(d, emptyPatch(d), { kind: "roomType", room: 0, type: "combat" });
  assert.throws(() => savePatch(data, d.id, bad), (e: { status?: number; issues?: unknown[] }) => e.status === 422 && (e.issues?.length ?? 0) > 0);
  assert.equal(listPool(data)[0].edits, 1, "a refused patch leaves the saved one");

  savePatch(data, d.id, emptyPatch(d));
  assert.ok(!existsSync(join(dir, `${d.id}.patch.json`)));
});

test("bake requests become the dungeon CLI's arguments, and bad ones are refused", () => {
  assert.deepEqual(bakeArgs({ count: 3, seed: 42, rank: 2, theme: "crypt" }), ["--n", "3", "--png", "--seed", "42", "--theme", "crypt", "--rank", "2"]);
  assert.deepEqual(bakeArgs({ count: 1, seed: "random", theme: "auto" }), ["--n", "1", "--png", "--seed", "random"]);
  for (const bad of [{ count: 0 }, { count: 51 }, { count: 1, seed: -1 }, { count: 1, theme: "../x" }, { count: 1, rank: 11 }]) {
    assert.throws(() => bakeArgs(bad as never), (e: { status?: number }) => e.status === 400, JSON.stringify(bad));
  }
});
