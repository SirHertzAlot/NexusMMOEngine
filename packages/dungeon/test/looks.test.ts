/**
 * content/dungeons/looks.json (how a run looks, per theme) names every theme the generator
 * knows, and gives each the palette slots a baked shell uses. A new built-in theme fails
 * here until it has a look.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_THEMES } from "../src/index.js";

const looks = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../content/dungeons/looks.json"), "utf8")) as {
  emitters: string[];
  maxLights: number;
  themes: Record<string, { palette: Record<string, string>; torch: { range: number } }>;
};

describe("content/dungeons/looks.json", () => {
  it("has a look for every built-in theme", () => {
    assert.deepEqual(Object.keys(looks.themes).sort(), Object.keys(BUILTIN_THEMES).sort());
  });

  it("colours each of the shell's material slots in every theme, and the props' (engine-core's PROP_SLOTS) beside them", () => {
    const shell = ["basin", "ceiling", "floor", "wall"];
    const props = ["stone", "wood", "metal", "cloth", "gold", "bone", "fire", "ice", "moss", "earth", "glass"];
    for (const [theme, l] of Object.entries(looks.themes)) {
      assert.deepEqual(Object.keys(l.palette).sort(), [...shell, ...props].sort(), `${theme}: palette slots`);
    }
  });

  it("names emitters that props.json spawns", () => {
    const props = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../content/dungeons/props.json"), "utf8")) as { archetypes: Record<string, unknown> };
    for (const e of looks.emitters) assert.ok(e in props.archetypes, `${e} is an emitter but no prop spawns it`);
    assert.ok(looks.maxLights >= 1);
  });
});
