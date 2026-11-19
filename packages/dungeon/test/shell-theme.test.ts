/**
 * Theme shell knobs: the schema refuses unknown knobs, each knob that is
 * accepted changes the bake (ceilingMode open drops the ceiling; the styles
 * are reported per part), and the knobs left out stay out.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { bakeCrypt, CRYPT_THEMES, dungeonShell, parseLayoutMask, SHELL_PARTS, parseShellTheme, shellOptionsOf, type CryptTheme, type GeometryOps, BUILTIN_THEMES, generateDungeon } from "../src/index.js";

const require = createRequire(import.meta.url);
const geo = require("@mmo-engine/addon-geometry") as GeometryOps;
const CEILING = SHELL_PARTS.indexOf("ceiling");
const ROOM = { version: 1 as const, rows: ["#########", "#.......#", "#.......#", "#.......#", "#########"], entrance: { x: 1, y: 1 }, portals: [] };

describe("shell theme knobs", () => {
  it("refuses an unknown knob (cellSize) instead of ignoring it", () => {
    for (const knob of ["cellSize"]) {
      assert.throws(() => parseShellTheme({ [knob]: 1 }), /unrecognized/i, knob);
    }
  });

  it("refuses an unknown ceiling mode and a style name that is not a slug", () => {
    assert.throws(() => parseShellTheme({ ceilingMode: "vaulted" }));
    assert.throws(() => parseShellTheme({ wallStyle: "Rough Stone" }));
  });

  it("ceilingMode open drops every ceiling triangle; flat keeps them", () => {
    const d = parseLayoutMask(ROOM);
    const dungeon = require("../src/index.js").dungeonFromLayout(d, "room");
    const flat = dungeonShell(dungeon, geo, { ceilingMode: "flat" });
    const open = dungeonShell(dungeon, geo, { ceilingMode: "open" });
    assert.ok(flat.parts.includes(CEILING), "flat has a ceiling");
    assert.ok(!open.parts.includes(CEILING), "open has no ceiling");
    assert.ok(open.stats.triangles < flat.stats.triangles);
  });

  it("a simplify tolerance is accepted and the shell still builds", () => {
    const d = require("../src/index.js").dungeonFromLayout(parseLayoutMask(ROOM), "room");
    const s = dungeonShell(d, geo, { simplifyTolerance: 0.5 });
    assert.ok(s.stats.triangles > 0);
    assert.ok(s.parts.includes(SHELL_PARTS.indexOf("floor")));
  });

  it("the bake reports the theme's floor and wall styles, and a changed style is reported", () => {
    const base = CRYPT_THEMES["dry-crypt"];
    assert.deepEqual(bakeCrypt(ROOM, base, geo).styles, { floor: "packed-earth", wall: "rough-stone" });
    const restyled: CryptTheme = { ...base, styles: { floor: "cracked-tile", wall: "brick" } };
    assert.deepEqual(bakeCrypt(ROOM, restyled, geo).styles, { floor: "cracked-tile", wall: "brick" });
  });

  it("the built-in themes' shell settings come through the schema unchanged", () => {
    assert.deepEqual(shellOptionsOf(parseShellTheme({ corridorHeight: 4 })).roomHeight, { s: 5, m: 6, l: 8 });
    assert.equal(CRYPT_THEMES["dry-crypt"].shell.corridorHeight, 4);
  });
});
