/**
 * content/dungeons/props.json (what each baked prop kind spawns as in a run) covers every
 * kind the generator and the dressing can place, bar the floor and wall litter that
 * waits for art. A new prop kind in the bake fails here until the table says what it is.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_DRESSING, BUILTIN_THEMES, dressDungeon, generateDungeon } from "../src/index.js";

/** Not in the table on purpose: litter and growth no stand-in box does justice (decals, ceiling and wall plants: they wait for art). */
const WAITS_FOR_ART = new Set(["crack", "moss", "debris", "bones", "icicle", "roots"]);

const table = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../content/dungeons/props.json"), "utf8")) as {
  archetypes: Record<string, { asset: string; collision?: { halfExtents?: number[] } }>;
  lift: Record<string, number>;
};

describe("content/dungeons/props.json", () => {
  it("has an entry for every kind the bake places (bar the litter that waits for art)", () => {
    const kinds = new Set<string>(["torch"]);
    for (const theme of Object.keys(BUILTIN_THEMES)) {
      for (const rank of [1, 3, 5]) {
        const d = generateDungeon({ seed: rank * 101 + theme.length, rooms: 34, loopChance: 0.2, decorDensity: 0.5, theme }, BUILTIN_THEMES[theme]);
        for (const p of d.props) kinds.add(p.kind);
        for (const p of dressDungeon(d, BUILTIN_DRESSING, rank).props) kinds.add(p.kind);
      }
    }
    const missing = [...kinds].filter((k) => !(`dungeon:${k}` in table.archetypes) && !WAITS_FOR_ART.has(k)).sort();
    assert.deepEqual(missing, [], `kinds the bake places that props.json doesn't name: ${missing.join(", ")}`);
  });

  it("names each kind's own asset and a box, and lifts only kinds that hang", () => {
    for (const [key, a] of Object.entries(table.archetypes)) {
      const kind = key.replace(/^dungeon:/, "");
      assert.ok(key.startsWith("dungeon:"), `${key}: keyed by asset id, dungeon:<kind>`);
      assert.equal(a.asset, key, `${kind}: asset id`);
      assert.equal(a.collision?.halfExtents?.length, 3, `${kind}: a collision box`);
      assert.ok(a.collision!.halfExtents!.every((h) => h > 0), `${kind}: a positive box`);
    }
    for (const kind of Object.keys(table.lift)) assert.ok(`dungeon:${kind}` in table.archetypes, `lift for "${kind}", which has no archetype`);
  });
});
