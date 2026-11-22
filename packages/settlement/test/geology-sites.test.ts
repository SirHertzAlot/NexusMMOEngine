/**
 * Geology must not cost the world its towns. The geology layer (engine-core terrain/geology) replaces the designer
 * mountain ranges with a province map; everything downstream (towns, the places between them, farms) reads the same
 * survey. Its first defaults turned about three times as much land into mountain as one designer range does, which
 * halved the flat green land towns need: six seeds went from 16 town sites to 5, and two had none, so bake:all stopped
 * at the settlement step. Narrower belts brought the towns back but not the roads: the belts' passes were too narrow
 * for the places planner's route grid, so towns stood cut off with no route, outpost or inn between them. This runs
 * the real site finder and the real places planner on the default world, and fails if geology loses more than one
 * town or leaves any town without a route.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findSites } from "../src/cli.js";
import { BUILTIN_RULES } from "../src/index.js";
import { townHalfExtentM } from "../src/layout.js";
import { planPlaces } from "../src/places.js";
import type { TerrainFields } from "../src/sites.js";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const engine = resolve(here, "../../../engine-core");

describe("geology keeps the towns and the roads between them", () => {
  it("the default world with geology supports as many 600-person towns as without (less one at most), all joined by routes", async () => {
    const terrain = pathToFileURL(join(engine, "dist/src/terrain")).href;
    const { generateGeologySpec } = (await import(`${terrain}/geology/snapshot.js`)) as { generateGeologySpec(p: { seed: number; min: number; max: number }): unknown };
    const { parseWorldSpec, worldBounds, loadWorldSpec } = (await import(`${terrain}/world-spec.js`)) as { parseWorldSpec(raw: unknown): unknown; worldBounds(spec: unknown): { min: number; max: number }; loadWorldSpec(file: string): { biomes: { id: string }[] } };
    const { surveyWorld } = (await import(`${terrain}/survey.js`)) as { surveyWorld(spec: unknown): TerrainFields };
    // Seed 7 had 3 sites without geology and 1 with the first defaults. Volcanoes are off in both arms: the default
    // volcano sits on the designer range's axis, which a geology world does not have.
    const raw = JSON.parse(readFileSync(join(engine, "worlds/default.world.json"), "utf8")) as Record<string, unknown> & { volcano: Record<string, unknown> };
    const off = { ...raw, seed: 7, volcano: { ...raw.volcano, count: 0 } };
    const b = worldBounds(parseWorldSpec(off));
    const on = { ...off, geology: generateGeologySpec({ seed: 7, min: b.min, max: b.max }) };
    const dir = mkdtempSync(join(tmpdir(), "geology-sites-"));
    try {
      const households = Math.round((600 * 10) / BUILTIN_RULES.demographics.householdSizeX10);
      const extent = townHalfExtentM(households, BUILTIN_RULES, 1);
      const write = (spec: unknown, name: string): string => {
        const file = join(dir, `${name}.world.json`);
        writeFileSync(file, JSON.stringify(spec));
        return file;
      };
      const without = (await findSites(write(off, "off"), here, BUILTIN_RULES, extent)).sites.length;
      const onFile = write(on, "on");
      const sites = (await findSites(onFile, here, BUILTIN_RULES, extent)).sites;
      assert.ok(without >= 2, `the designer-range world should hold towns (${without})`);
      assert.ok(sites.length >= without - 1, `geology lost towns: ${without} sites without it, ${sites.length} with it`);
      // The bake plans routes between every town it bakes (all the sites), and the roadside places along them.
      const towns = sites.map((s, i) => ({ id: String(i + 1), x: s.x, z: s.z }));
      const spec = loadWorldSpec(onFile);
      const plan = planPlaces({ towns, terrain: { ...surveyWorld(spec), biomeIds: spec.biomes.map((b) => b.id) }, seed: 1234 });
      const joined = new Set(plan.routes.flatMap((r) => [r.from, r.to]));
      const cutOff = towns.filter((t) => !joined.has(t.id)).map((t) => t.id);
      assert.deepEqual(cutOff, [], `towns with no route to any other: ${cutOff.join(", ")} (${plan.routes.length} routes for ${towns.length} towns)`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
