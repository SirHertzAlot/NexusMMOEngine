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
import { applyBrush, HeightGrid } from "@mmo-engine/protocol";
import {
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
  const run = (dir: string, args: string[], input = ""): { status: number | null; out: string; err: string } => {
    const r = spawnSync(process.execPath, [path.join(DIST, args[0]), ...args.slice(1)], {
      env: { ...process.env, MMO_DATA_DIR: dir },
      input,
      encoding: "utf8",
      timeout: 60_000,
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

  test("refuses to save while a server owns the world", () => {
    const dir = tmpDir();
    // This test process stands in for the running server.
    fs.writeFileSync(path.join(dir, SERVER_PID_FILE), String(process.pid));
    const r = run(dir, ["terrain-tool.js", "import"], JSON.stringify({ tiles: [] }));
    assert.equal(r.status, 1);
    assert.match(r.err, new RegExp(`game server \\(pid ${process.pid}\\) is running`));
  });
});
