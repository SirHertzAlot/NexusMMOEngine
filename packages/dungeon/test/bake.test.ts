/**
 * Baking: N unique dungeons to files and an index; later bakes add to the
 * pool without repeating a layout; the files round-trip; the CLI's option
 * forms (including `npm run dungeon:bake --n 10`) all mean the same.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bakeDungeons, BUILTIN_THEMES, decodeDungeon, dungeonPng, encodeDungeon, generateDungeon, layoutHash, loadThemes, readIndex,
  type BakeOptions, type DungeonFile,
} from "../src/index.js";
import { readOptions } from "../src/cli.js";
import { dungeonShell, SHELL_PARTS, type GeometryOps } from "../src/index.js";
import { decodePcgMesh } from "@mmo-engine/picg";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const geo = createRequire(import.meta.url)("@mmo-engine/addon-geometry") as GeometryOps;

const options = (out: string, over: Partial<BakeOptions> = {}): BakeOptions => ({
  count: 6, seed: 1, theme: "auto", rooms: [14, 24], loopChance: 0.15, decorDensity: 0.6, themes: BUILTIN_THEMES, out, ...over,
});
const tmp = (): string => mkdtempSync(join(tmpdir(), "dungeons-"));

describe("bakeDungeons", () => {
  it("bakes N unique dungeons with an index, the same pool every time", () => {
    const a = tmp(), b = tmp();
    const ra = bakeDungeons(options(a));
    bakeDungeons(options(b));
    assert.equal(ra.added.length, 6);
    assert.equal(new Set(ra.added.map((d) => d.hash)).size, 6, "all unique");
    assert.deepEqual(readIndex(a), readIndex(b), "same options, same pool");
    assert.equal(readdirSync(a).filter((f) => f.endsWith(".dungeon.json")).length, 6);
  });

  it("adds to an existing pool without repeating a layout, and fresh starts over", () => {
    const out = tmp();
    bakeDungeons(options(out));
    const more = bakeDungeons(options(out, { count: 4 }));
    assert.equal(more.index.dungeons.length, 10);
    assert.equal(new Set(more.index.dungeons.map((d) => d.hash)).size, 10);
    const again = bakeDungeons(options(out, { count: 2, fresh: true }));
    assert.equal(again.index.dungeons.length, 2);
  });

  it("prebakes each dungeon's shell as one PCGM buffer, and fresh removes it", () => {
    const out = tmp();
    const r = bakeDungeons(options(out, { count: 2, shell: { geo } }));
    for (const e of r.added) {
      assert.ok(e.shell, "the index records the shell");
      const bytes = readFileSync(join(out, e.shell.file));
      assert.equal(bytes.byteLength, e.shell.bytes);
      const mesh = decodePcgMesh(bytes);
      assert.deepEqual(mesh.materials, [...SHELL_PARTS]);
      assert.equal(mesh.indices.length / 3, e.shell.triangles);
      assert.equal(mesh.positions.length / 3, e.shell.vertices);
      // The same shell dungeonShell builds from the layout file.
      const d = decodeDungeon(JSON.parse(readFileSync(join(out, e.file), "utf8")) as DungeonFile);
      assert.deepEqual(mesh.indices, dungeonShell(d, geo).indices);
    }
    assert.equal(bakeDungeons(options(tmp(), { count: 1 })).added[0].shell, undefined, "no shell unless asked");
    bakeDungeons(options(out, { count: 1, fresh: true }));
    assert.equal(readdirSync(out).filter((f) => f.endsWith(".shell.pcgm")).length, 0);
  });

  it("uses one theme when asked, and rejects an unknown one", () => {
    const r = bakeDungeons(options(tmp(), { theme: "grim", count: 3 }));
    assert.ok(r.added.every((d) => d.theme === "grim"));
    assert.throws(() => bakeDungeons(options(tmp(), { theme: "lava" })), /no theme "lava"/);
  });
});

describe("dungeon files", () => {
  it("round-trip exactly", () => {
    const d = generateDungeon({ seed: 99, rooms: 25, loopChance: 0.2, decorDensity: 0.5, theme: "frost" }, BUILTIN_THEMES.frost);
    const back = decodeDungeon(JSON.parse(JSON.stringify(encodeDungeon(d))) as DungeonFile);
    assert.equal(layoutHash(back), layoutHash(d));
    assert.deepEqual(back.distance, d.distance);
    assert.deepEqual(back.doorway, d.doorway);
  });

  it("refuse another format and truncated grids", () => {
    const f = encodeDungeon(generateDungeon({ seed: 5, rooms: 15, loopChance: 0, decorDensity: 0, theme: "ancient" }, BUILTIN_THEMES.ancient));
    assert.throws(() => decodeDungeon({ ...f, format: "other" } as unknown as DungeonFile), /not a mmo-dungeon\/1 file/);
    assert.throws(() => decodeDungeon({ ...f, grids: { ...f.grids, grid: "AAAA" } }), /grid: 3 cells/);
  });

  it("draw as a PNG map", () => {
    const d = generateDungeon({ seed: 5, rooms: 15, loopChance: 0, decorDensity: 0, theme: "ancient" }, BUILTIN_THEMES.ancient);
    const png = dungeonPng(d, 2);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), d.width * 2);
    assert.equal(png.readUInt32BE(20), d.height * 2);
  });
});

describe("themes", () => {
  it("merge a game's themes over the built-in ones, reporting every problem", () => {
    const dir = tmp();
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ abyss: { label: "ABYSS", nameA: ["Screaming"], nameB: ["Pits"], bones: true } }));
    const themes = loadThemes(good);
    assert.ok(themes.abyss && themes.ancient);
    assert.equal(themes.abyss.pools, null);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ abyss: { label: "", nameA: [], nameB: ["Pits"], lava: true } }));
    assert.throws(() => loadThemes(bad), (e: Error) => /abyss\.label/.test(e.message) && /abyss\.nameA/.test(e.message) && /lava/.test(e.message));
  });
});

describe("the bake command's options", () => {
  it("reads --n 10, --n=10, and npm's `npm run dungeon:bake --n 10` (a lone 10) alike", () => {
    assert.equal(readOptions(["--n", "10"], {}).n, "10");
    assert.equal(readOptions(["--n=10"], {}).n, "10");
    assert.equal(readOptions(["10"], { npm_config_n: "true" }).n, "10");
    assert.equal(readOptions([], { npm_config_seed: "7" }).seed, "7");
    assert.equal(readOptions(["--fresh", "--png"], {}).png, "true");
    assert.throws(() => readOptions(["--count", "3"], {}), /unknown option --count/);
    assert.throws(() => readOptions(["10", "11"], {}), /unexpected argument "11"/);
    assert.equal(readOptions(["--no-shell"], {})["no-shell"], "true");
    assert.equal(readOptions([], { npm_config_no_shell: "true" })["no-shell"], "true", "npm's --no-shell");
  });
});
