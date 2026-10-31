/**
 * dungeonShell against real layouts and the real geometry addon (manifold +
 * Clipper2): the shell is checked against the layout it came from, cell by
 * cell, and as a surface (closed, facing into the space you walk in).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { BUILTIN_THEMES, CELL, dungeonShell, generateDungeon, SHELL_DEFAULTS, SHELL_PARTS, type Dungeon, type GeometryOps } from "../src/index.js";

const require = createRequire(import.meta.url);
const geo = require("@mmo-engine/addon-geometry") as GeometryOps;

const make = (seed: number, theme = "ancient", rooms = 12): Dungeon =>
  generateDungeon({ seed, rooms, loopChance: 0.15, decorDensity: 0.6, theme }, BUILTIN_THEMES[theme]);

const FLOOR = SHELL_PARTS.indexOf("floor");
const CEILING = SHELL_PARTS.indexOf("ceiling");
const BASIN = SHELL_PARTS.indexOf("basin");

/** Distinct heights of the shell's triangles of `part` straight above or below (x, z) (a point on a shared edge hits both triangles). */
function heightsAt(s: ReturnType<typeof dungeonShell>, part: number, x: number, z: number): number[] {
  const p = s.positions, idx = s.indices;
  const out: number[] = [];
  for (let t = 0; t < s.parts.length; t++) {
    if (s.parts[t] !== part) continue;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    // Barycentric in x-z.
    const d = (p[b + 2] - p[c + 2]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 2] - p[c + 2]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((p[b + 2] - p[c + 2]) * (x - p[c]) + (p[c] - p[b]) * (z - p[c + 2])) / d;
    const l2 = ((p[c + 2] - p[a + 2]) * (x - p[c]) + (p[a] - p[c]) * (z - p[c + 2])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
    const h = Math.round((l1 * p[a + 1] + l2 * p[b + 1] + l3 * p[c + 1]) * 1e6) / 1e6;
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

describe("dungeonShell (manifold + Clipper2)", () => {
  const d = make(1337, "ancient", 12);
  const s = dungeonShell(d, geo);
  const cell = SHELL_DEFAULTS.cell;
  const size = new Map(d.rooms.map((r) => [r.id, r.size]));

  it("puts floor under every walkable cell, and the right ceiling over it", () => {
    let checked = 0;
    for (let y = 0; y < d.height; y++) {
      for (let x = 0; x < d.width; x++) {
        const i = y * d.width + x;
        const g = d.grid[i];
        const cx = (x + 0.5) * cell, cz = (y + 0.5) * cell;
        if (g === CELL.floor) {
          assert.deepEqual(heightsAt(s, FLOOR, cx, cz), [0], `floor at cell ${x},${y}`);
          const room = d.roomId[i] >= 0 ? size.get(d.roomId[i]) : undefined;
          const want = Math.max(SHELL_DEFAULTS.corridorHeight, room ? SHELL_DEFAULTS.roomHeight[room] : 0);
          assert.deepEqual(heightsAt(s, CEILING, cx, cz), [want], `ceiling over cell ${x},${y}`);
          checked++;
        } else if (g === CELL.pool) {
          assert.deepEqual(heightsAt(s, BASIN, cx, cz), [-SHELL_DEFAULTS.poolDepth], `basin at cell ${x},${y}`);
        } else {
          assert.deepEqual(heightsAt(s, FLOOR, cx, cz), [], `rock at cell ${x},${y}`);
        }
      }
    }
    assert.equal(checked, d.grid.filter((g) => g === CELL.floor).length);
  });

  it("covers exactly the floor plan", () => {
    const area = (part: number): number => {
      let sum = 0;
      const p = s.positions, idx = s.indices;
      for (let t = 0; t < s.parts.length; t++) {
        if (s.parts[t] !== part) continue;
        const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
        sum += Math.abs((p[b] - p[a]) * (p[c + 2] - p[a + 2]) - (p[c] - p[a]) * (p[b + 2] - p[a + 2])) / 2;
      }
      return sum;
    };
    const walkable = d.grid.filter((g) => g === CELL.floor || g === CELL.pool).length * cell * cell;
    assert.ok(Math.abs(s.stats.floorArea - walkable) < 1e-6);
    assert.ok(Math.abs(area(FLOOR) + area(BASIN) - walkable) < 1e-3, `floor + basins = the plan (${area(FLOOR) + area(BASIN)} vs ${walkable})`);
    assert.equal(s.stats.pools, d.pools.length);
  });

  it("is a closed surface facing into the space you walk in", () => {
    // Every edge is shared by exactly two triangles, once each way.
    const edges = new Map<string, number>();
    const idx = s.indices;
    for (let t = 0; t < idx.length / 3; t++) {
      for (let j = 0; j < 3; j++) {
        const a = idx[t * 3 + j], b = idx[t * 3 + ((j + 1) % 3)];
        const k = `${a},${b}`;
        edges.set(k, (edges.get(k) ?? 0) + 1);
      }
    }
    for (const [k, n] of edges) {
      const [a, b] = k.split(",");
      assert.equal(n, 1, `edge ${k} used once`);
      assert.equal(edges.get(`${b},${a}`), 1, `edge ${k} has its twin`);
    }
    // Facing inward: the signed volume the surface encloses is minus the space's volume.
    const p = s.positions;
    let v = 0;
    for (let t = 0; t < idx.length / 3; t++) {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    }
    assert.ok(s.stats.volume > 0);
    assert.ok(Math.abs(v + s.stats.volume) / s.stats.volume < 1e-4, `signed volume ${v} vs space ${s.stats.volume}`);
  });

  it("stays inside its bounds, and is the same every time", () => {
    assert.equal(s.bounds.min[1], s.stats.pools > 0 ? -SHELL_DEFAULTS.poolDepth : 0);
    assert.ok(s.bounds.min[0] >= 0 && s.bounds.min[2] >= 0, "within the grid");
    assert.ok(s.bounds.max[0] <= d.width * cell && s.bounds.max[2] <= d.height * cell, "within the grid");
    assert.equal(s.bounds.max[1], SHELL_DEFAULTS.roomHeight.l > SHELL_DEFAULTS.corridorHeight && d.rooms.some((r) => r.size === "l") ? SHELL_DEFAULTS.roomHeight.l : s.bounds.max[1]);
    const again = dungeonShell(d, geo);
    assert.deepEqual(Buffer.from(again.positions.buffer), Buffer.from(s.positions.buffer));
    assert.deepEqual(again.indices, s.indices);
    assert.deepEqual(again.parts, s.parts);
  });

  it("builds every theme's dungeons, pools included", () => {
    let withPools = 0;
    for (const theme of Object.keys(BUILTIN_THEMES)) {
      const t = dungeonShell(make(7, theme, 10), geo);
      assert.ok(t.stats.triangles > 100, theme);
      if (t.stats.pools > 0) {
        withPools++;
        assert.ok(t.parts.includes(BASIN), `${theme} has basins`);
      }
    }
    assert.ok(withPools > 0, "some theme has pools");
  });

  it("refuses a layout without floor", () => {
    const empty = { ...d, grid: new Uint8Array(d.grid.length) };
    assert.throws(() => dungeonShell(empty, geo), /no floor/);
  });
});

describe("dungeonShell with laid interiors", () => {
  const d = make(1337, "ancient", 12);
  const cell = SHELL_DEFAULTS.cell;
  const size = new Map(d.rooms.map((r) => [r.id, r.size]));
  const whole = dungeonShell(d, geo);
  const s = dungeonShell(d, geo, { laidRooms: d.rooms.map((r) => r.id) });
  const WALL = SHELL_PARTS.indexOf("wall");
  const walkable = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < d.width && y < d.height && (d.grid[y * d.width + x] === CELL.floor || d.grid[y * d.width + x] === CELL.pool);

  // The closed edges of the laid rooms: each room cell against rock or void, as a grid segment under the room's height.
  const closed: { x0: number; z0: number; x1: number; z1: number; h: number }[] = [];
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const sizeOf = size.get(d.roomId[y * d.width + x]);
      if (sizeOf === undefined || !walkable(x, y)) continue;
      const h = SHELL_DEFAULTS.roomHeight[sizeOf];
      const edge = (x0: number, z0: number, x1: number, z1: number): void => {
        closed.push({ x0: x0 * cell, z0: z0 * cell, x1: x1 * cell, z1: z1 * cell, h });
      };
      if (!walkable(x, y - 1)) edge(x, y, x + 1, y);
      if (!walkable(x, y + 1)) edge(x, y + 1, x + 1, y + 1);
      if (!walkable(x - 1, y)) edge(x, y, x, y + 1);
      if (!walkable(x + 1, y)) edge(x + 1, y, x + 1, y + 1);
    }
  }

  /** Is (x, y, z) on a closed edge of a laid room, under its height? Corners count: they are the segments' ends. */
  const onClosedEdge = (x: number, y: number, z: number): boolean =>
    closed.some((e) => {
      const dx = e.x1 - e.x0, dz = e.z1 - e.z0;
      const t = Math.max(0, Math.min(1, ((x - e.x0) * dx + (z - e.z0) * dz) / (dx * dx + dz * dz)));
      return Math.hypot(x - (e.x0 + t * dx), z - (e.z0 + t * dz)) < 1e-3 && y > -1e-3 && y < e.h + 1e-3;
    });

  it("drops wall faces and nothing else", () => {
    const count = (sh: { parts: Uint8Array }, part: number): number => sh.parts.filter((p) => p === part).length;
    for (const part of [FLOOR, CEILING, BASIN]) assert.equal(count(s, part), count(whole, part), SHELL_PARTS[part]);
    assert.ok(count(s, WALL) < count(whole, WALL), "some wall faces are dropped");
    assert.ok(count(s, WALL) > 0, "the other walls stand");
  });

  it("opens the surface only along the closed edges of laid rooms", () => {
    const p = s.positions, idx = s.indices;
    const directed = new Set<string>();
    for (let t = 0; t < idx.length / 3; t++) {
      for (let j = 0; j < 3; j++) directed.add(`${idx[t * 3 + j]},${idx[t * 3 + ((j + 1) % 3)]}`);
    }
    let open = 0;
    for (const k of directed) {
      const [a, b] = k.split(",").map(Number);
      if (directed.has(`${b},${a}`)) continue;
      open++;
      for (const v of [a, b]) assert.ok(onClosedEdge(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]), `open edge ${k} starts off a laid room's closed edge`);
      const mid = [0, 1, 2].map((j) => (p[a * 3 + j] + p[b * 3 + j]) / 2);
      assert.ok(onClosedEdge(mid[0], mid[1], mid[2]), `open edge ${k} runs off a laid room's closed edge`);
    }
    assert.ok(open > 0, "the laid walls left openings in the shell");
  });

  it("is the same shell as before when no room is laid", () => {
    const none = dungeonShell(d, geo, { laidRooms: [] });
    assert.deepEqual(none.indices, whole.indices);
    assert.deepEqual(none.parts, whole.parts);
  });
});
