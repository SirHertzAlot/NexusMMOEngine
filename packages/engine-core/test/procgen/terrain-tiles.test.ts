/**
 * Stored world heightmap: tiles round-trip through world.db, the server's
 * chunk source prefers them over the generator, and the terrain tool (the
 * only writer) keeps seams closed, props planted, and never writes under
 * a running server.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { applyBrush, HeightGrid, type TerrainTile } from "@mmo-engine/protocol";
import {
  ChunkEntityStore,
  decodeSnapshot,
  encodeSnapshot,
  SnapshotStore,
  terrainHeightAt,
  heightsFingerprint,
  makeTileChunkSource,
  runningServerPid,
  SERVER_PID_FILE,
  TerrainTileStore,
  type ChunkDataSource,
} from "../../src/index.js";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "mmo-terrain-"));

function ramp(offset: number): Float32Array {
  return Float32Array.from({ length: 256 }, (_, i) => i * 0.01 + offset);
}

describe("TerrainTileStore", () => {
  test("round-trips tiles exactly and upserts", () => {
    const store = new TerrainTileStore(path.join(tmpDir(), "world.db"));
    assert.equal(store.count(), 0);
    assert.equal(store.get(0, 0), null);
    store.putMany([{ cx: 0, cz: 0, heights: ramp(0) }, { cx: -1, cz: 2, heights: ramp(5) }]);
    assert.deepStrictEqual(store.get(-1, 2), ramp(5));
    store.putMany([{ cx: 0, cz: 0, heights: ramp(9) }]);
    assert.deepStrictEqual(store.get(0, 0), ramp(9));
    assert.equal(store.count(), 2);
    assert.deepEqual(store.list().map((t) => [t.cx, t.cz]), [[0, 0], [-1, 2]]);
    assert.throws(() => store.putMany([{ cx: 1, cz: 1, heights: new Float32Array(10) }]), /256/);
    assert.equal(store.count(), 2, "failed batch wrote nothing");
    store.close();
  });
});

describe("makeTileChunkSource", () => {
  test("stored tiles win; missing chunks and LOD > 0 use the generator", () => {
    const generator: ChunkDataSource = {
      chunkSamples: 256,
      generateChunk: (_s, _cx, _cz, _lod, out) => out.fill(-7),
    };
    const stored = new Map([["0,0", ramp(1)]]);
    const source = makeTileChunkSource(
      { get: (cx, cz) => stored.get(`${cx},${cz}`) ?? null },
      generator,
    );
    const out = new Float32Array(256);
    source.generateChunk(1n, 0, 0, 0, out);
    assert.deepStrictEqual(out, ramp(1));
    source.generateChunk(1n, 5, 5, 0, out);
    assert.equal(out[0], -7, "unbaked chunk comes from the generator");
    source.generateChunk(1n, 0, 0, 1, out);
    assert.equal(out[0], -7, "LOD > 0 comes from the generator");
  });

  test("heightsFingerprint changes with any sample", () => {
    const a = ramp(0);
    const b = ramp(0);
    assert.equal(heightsFingerprint(a), heightsFingerprint(b));
    b[200] += 0.001;
    assert.notEqual(heightsFingerprint(a), heightsFingerprint(b));
  });
});

describe("runningServerPid", () => {
  test("live pid counts; stale, garbage, and own pid don't", () => {
    const dir = tmpDir();
    assert.equal(runningServerPid(dir), null, "no file");
    fs.writeFileSync(path.join(dir, SERVER_PID_FILE), String(process.pid));
    assert.equal(runningServerPid(dir), null, "own pid is not 'another server'");
    fs.writeFileSync(path.join(dir, SERVER_PID_FILE), "not-a-pid");
    assert.equal(runningServerPid(dir), null, "garbage");
    fs.writeFileSync(path.join(dir, SERVER_PID_FILE), "999999999");
    assert.equal(runningServerPid(dir), null, "dead pid (crashed server)");
    fs.writeFileSync(path.join(dir, SERVER_PID_FILE), String(process.ppid));
    assert.equal(runningServerPid(dir), process.ppid, "live process");
  });
});

describe("terrain-tool (the editor's terrain writer)", () => {
  // The legacy 3x3-chunk world unless a test passes a world spec.
  const run = (
    dir: string,
    args: string[],
    input = "",
    env: Record<string, string> = { MMO_WORLD_SPEC: "none" },
  ): { status: number | null; out: string; err: string } => {
    const r = spawnSync(process.execPath, [path.join(DIST, args[0]), ...args.slice(1)], {
      env: { ...process.env, MMO_DATA_DIR: dir, ...env },
      input,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024, // an exported area is a few MB of JSON
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };

  test("bake -> sculpt across a border -> save: seams closed, props re-seated, idempotent", { timeout: 120_000 }, () => {
    const dir = tmpDir();
    assert.equal(run(dir, ["bake-world.js"]).status, 0, "bake");
    const exp = JSON.parse(run(dir, ["terrain-tool.js", "export"]).out);
    assert.equal(exp.stored, true);
    assert.equal(exp.tiles.length, 9);
    assert.ok(exp.props.length > 0, "baked props");

    const grid = HeightGrid.fromTiles(
      exp.tiles.map((t: { cx: number; cz: number; heights: number[] }) => ({ ...t, heights: Float32Array.from(t.heights) })),
    );
    // Raise a broad hill over the whole middle chunk (and its borders), so
    // props standing there must move.
    const touched = new Set<string>();
    for (let k = 0; k < 5; k++) {
      for (const key of applyBrush(grid, { tool: "raise", x: 8, z: 8, radius: 14, strength: 1 })) touched.add(key);
    }
    const edit = {
      tiles: [...touched].map((key) => {
        const [cx, cz] = key.split(",").map(Number);
        return { cx, cz, heights: Array.from(grid.tile(cx, cz).heights) };
      }),
    };
    const saved = run(dir, ["terrain-tool.js", "import"], JSON.stringify(edit));
    assert.equal(saved.status, 0, saved.err);
    const result = JSON.parse(saved.out);
    assert.equal(result.saved, touched.size);
    assert.ok(result.reseatedProps > 0, "props on the hill moved");

    // Re-export: the hill is stored, and props sit on the new ground.
    const after = JSON.parse(run(dir, ["terrain-tool.js", "export"]).out);
    const afterGrid = HeightGrid.fromTiles(
      after.tiles.map((t: { cx: number; cz: number; heights: number[] }) => ({ ...t, heights: Float32Array.from(t.heights) })),
    );
    assert.deepStrictEqual(afterGrid.tile(0, 0).heights, grid.tile(0, 0).heights);

    // Saving the same tiles again changes nothing (no double re-seat).
    const again = JSON.parse(run(dir, ["terrain-tool.js", "import"], JSON.stringify(edit)).out);
    assert.deepEqual([again.saved, again.reseatedProps], [0, 0]);
  });

  test("rejects a tile that opens a seam", { timeout: 120_000 }, () => {
    const dir = tmpDir();
    assert.equal(run(dir, ["bake-world.js"]).status, 0);
    const exp = JSON.parse(run(dir, ["terrain-tool.js", "export"]).out);
    const tile = exp.tiles.find((t: { cx: number; cz: number }) => t.cx === 0 && t.cz === 0);
    tile.heights[4 * 16 + 15] += 2; // shared with chunk (1,0)
    const r = run(dir, ["terrain-tool.js", "import"], JSON.stringify({ tiles: [tile] }));
    assert.equal(r.status, 1);
    assert.match(r.err, /disagree on shared sample/);
  });

  /** Bake a small (32x32-chunk) spec world into `dir`; returns the env for the tools. */
  const bakeSmallWorld = (dir: string): Record<string, string> => {
    const specFile = path.join(dir, "small.world.json");
    fs.writeFileSync(
      specFile,
      JSON.stringify({
        name: "small",
        seed: 77,
        sizeChunks: 32,
        // All land (sea only on the south edge, beyond the world): these
        // tests are about the terrain tool, not the coast.
        land: { coast: { waterEdge: 0.25, tip: 1 } },
        ranges: { count: 1, height: 60, width: 140, length: 300, ridgeScale: 120, coastClearance: 0 },
        erosion: { droplets: 2000, strength: 0.35, thermalPasses: 6, fluvialPasses: 2 },
        biomes: [
          { id: "hills", when: { height: { min: 40 } }, surface: { shape: "ridged", relief: 6, scale: 200 }, roughness: 1 },
          { id: "plains", surface: { shape: "rolling", relief: 6, scale: 200 }, roughness: 0.4 },
        ],
      }),
    );
    const env = { MMO_WORLD_SPEC: specFile, MMO_WORLD_CATALOG: "0" };
    const bake = run(dir, ["bake-world.js"], "", env);
    assert.equal(bake.status, 0, bake.err);
    return env;
  };
  const wireTiles = (tiles: Array<{ cx: number; cz: number; heights: number[] }>): TerrainTile[] =>
    tiles.map((t) => ({ ...t, heights: Float32Array.from(t.heights) }));

  test("baked world: export loads one area, import checks its edge against unloaded tiles", { timeout: 180_000 }, () => {
    const dir = tmpDir();
    const env = bakeSmallWorld(dir);

    const whole = JSON.parse(run(dir, ["terrain-tool.js", "export"], "", env).out);
    assert.equal(whole.tiles.length, 17 * 17, "default area: radius 8 around (0,0)");
    assert.equal(whole.totalTiles, 32 * 32);
    assert.deepEqual(whole.world, { name: "small", minChunk: -16, maxChunk: 15 });
    assert.equal(whole.seed, "77");

    // Area: chunks 1..5 x -4..0. Its east edge (world x = 96) is shared
    // with chunks 6.., which the editor never loaded.
    const area = { cx: 3, cz: -2, radius: 2 };
    const exp = JSON.parse(run(dir, ["terrain-tool.js", "export"], JSON.stringify(area), env).out);
    assert.equal(exp.tiles.length, 25);
    assert.equal(exp.partial, true);
    assert.deepEqual(exp.area, area);
    const tiles = exp.tiles.map((t: { cx: number; cz: number; heights: number[] }) => ({
      ...t,
      heights: Float32Array.from(t.heights),
    }));
    const sculpt = (pinned: boolean): string => {
      const grid = HeightGrid.fromTiles(tiles);
      if (pinned) grid.pinBorders();
      const touched = new Set<string>();
      for (let k = 0; k < 3; k++) {
        for (const key of applyBrush(grid, { tool: "raise", x: 96, z: -24, radius: 10, strength: 1 })) touched.add(key);
      }
      return JSON.stringify({
        tiles: [...touched].map((key) => {
          const [cx, cz] = key.split(",").map(Number);
          return { cx, cz, heights: Array.from(grid.tile(cx, cz).heights) };
        }),
      });
    };
    // Moving the shared edge would open a seam against chunk 6: rejected.
    const loose = run(dir, ["terrain-tool.js", "import"], sculpt(false), env);
    assert.equal(loose.status, 1);
    assert.match(loose.err, /disagree on shared sample/);
    // With the edge pinned (what the editor does), the same stroke saves.
    const pinned = run(dir, ["terrain-tool.js", "import"], sculpt(true), env);
    assert.equal(pinned.status, 0, pinned.err);
    assert.ok(JSON.parse(pinned.out).saved > 0);

    const outside = { cx: 16, cz: 0, heights: Array.from({ length: 256 }, () => 0) };
    const r = run(dir, ["terrain-tool.js", "import"], JSON.stringify({ tiles: [outside] }), env);
    assert.equal(r.status, 1);
    assert.match(r.err, /outside the world \(chunks -16\.\.15\)/);

    const tooBig = run(dir, ["terrain-tool.js", "export"], JSON.stringify({ radius: 99 }), env);
    assert.equal(tooBig.status, 1);
    assert.match(tooBig.err, /area radius/);
  });

  test("props of unloaded chunks (their rows) are exported and re-seated", { timeout: 180_000 }, () => {
    const dir = tmpDir();
    const env = bakeSmallWorld(dir);
    const dbPath = path.join(dir, "world.db");
    // A chunk far from the spawn area (which the bake left loaded).
    const meta = new SnapshotStore({ dbPath });
    const spawn = JSON.parse(meta.getMeta("spawn_point")!) as { x: number; z: number };
    meta.close();
    const cx = spawn.x >= 0 ? -12 : 12;
    const cz = spawn.z >= 0 ? -12 : 12;
    const tiles = new TerrainTileStore(dbPath);
    const ground = tiles.get(cx, cz)!;
    tiles.close();
    const [lx, lz] = [5, 7];
    const [x, z] = [cx * 16 + lx, cz * 16 + lz];
    const y = terrainHeightAt(ground, lx, lz, 16);
    // The chunk unloaded with a tree in it: the tree is only in its row.
    const rows = new ChunkEntityStore(dbPath);
    rows.putMany([{
      cx, cz, tick: 5,
      bytes: encodeSnapshot({
        tick: 5, baseTick: 0,
        transforms: [{ wireId: 77n, px: x, py: y, pz: z, qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 1, sz: 1 }],
        velocities: [], intents: [], chunks: [], healths: [], staminas: [], bodies: [], assets: [], locomotions: [], appearances: [], actions: [], characterRefs: [], spawned: [], despawned: [],
      }),
    }]);
    rows.close();

    const area = { cx, cz, radius: 1 };
    const exp = JSON.parse(run(dir, ["terrain-tool.js", "export"], JSON.stringify(area), env).out);
    assert.ok(
      exp.props.some(([px, py, pz]: number[]) => px === x && pz === z && Math.abs(py - y) < 1e-4),
      "the row's tree is exported",
    );

    // Raise the ground under the tree, and save.
    const grid = HeightGrid.fromTiles(wireTiles(exp.tiles));
    grid.pinBorders();
    const touched = applyBrush(grid, { tool: "raise", x, z, radius: 5, strength: 3 });
    const edit = {
      tiles: [...touched].map((key) => {
        const [tx, tz] = key.split(",").map(Number);
        return { cx: tx, cz: tz, heights: Array.from(grid.tile(tx, tz).heights) };
      }),
    };
    const saved = run(dir, ["terrain-tool.js", "import"], JSON.stringify(edit), env);
    assert.equal(saved.status, 0, saved.err);
    assert.equal(JSON.parse(saved.out).reseatedProps, 1);

    const after = new ChunkEntityStore(dbPath);
    const tree = decodeSnapshot(after.get(cx, cz)!.bytes).transforms[0];
    after.close();
    const newGround = terrainHeightAt(grid.tile(cx, cz).heights, lx, lz, 16);
    assert.ok(newGround > y + 1, "the ground rose");
    assert.ok(Math.abs(tree.py - newGround) < 1e-3, `the tree stands on it (${tree.py} vs ${newGround})`);
  });

  test("refuses to save while a server owns the world", () => {
    const dir = tmpDir();
    // This test process stands in for the running server.
    fs.writeFileSync(path.join(dir, SERVER_PID_FILE), String(process.pid));
    const r = run(dir, ["terrain-tool.js", "import"], JSON.stringify({ tiles: [] }));
    assert.equal(r.status, 1);
    assert.match(r.err, new RegExp(`game server \\(pid ${process.pid}\\) is running`));
  });
});
