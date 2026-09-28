import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  fnv1a32,
  parseSpawnTableJSON,
  resolveSpawns,
  type SpawnTable,
} from "../src/spawn-table.js";
import { parseGraphJSON } from "../src/schema.js";
import { cook } from "../src/cooker.js";
import { evaluatePlan } from "../src/reference.js";

const here = dirname(fileURLToPath(import.meta.url));
function loadTable(): SpawnTable {
  return parseSpawnTableJSON(
    JSON.parse(
      readFileSync(join(here, "..", "..", "examples", "forest.spawn-table.json"), "utf8"),
    ),
  );
}

test("fnv1a32 golden vectors", () => {
  assert.equal(fnv1a32("oak"), 2823540338);
  assert.equal(fnv1a32("pine"), 341699939);
  assert.equal(fnv1a32(""), 2166136261); // offset basis
  assert.equal(fnv1a32("oak"), fnv1a32("oak"));
  assert.notEqual(fnv1a32("oak"), fnv1a32("pine"));
});

test("example spawn table parses", () => {
  const t = loadTable();
  assert.equal(t.version, 1);
  assert.ok(t.archetypes.oak);
  assert.ok(t.archetypes.pine);
  assert.ok(t.archetypes.birch);
  assert.equal(t.archetypes.oak.collision?.shape, "box");
  assert.equal(t.archetypes.oak.health?.max, 100);
});

test("resolveSpawns maps records to entity spawns", () => {
  const table = loadTable();
  const graph = parseGraphJSON(
    JSON.parse(readFileSync(join(here, "..", "..", "examples", "forest.pcg.json"), "utf8")),
  );
  const plan = cook(graph);
  const recs = evaluatePlan(plan, {
    worldSeed: 1234,
    cx: 0,
    cz: 0,
    heightAt: () => 0,
  });
  const spawns = resolveSpawns(recs, table);
  assert.equal(spawns.length, recs.length);
  for (const s of spawns) {
    assert.equal(s.assetHash, fnv1a32(s.assetId));
    assert.ok(s.variant >= 0 && s.variant <= 0xffff);
    assert.ok(s.archetype);
    assert.equal(s.seed, recs.find((r) => r.seed === s.seed)?.seed);
  }
  // oak archetype carries its collision + health bundle
  const oak = spawns.find((s) => s.assetId === "oak");
  if (oak) {
    assert.equal(oak.archetype.collision?.shape, "box");
    assert.equal(oak.archetype.health?.max, 100);
  }
});

test("resolveSpawns throws on asset missing from the table", () => {
  const table = loadTable();
  assert.throws(
    () =>
      resolveSpawns(
        [
          {
            x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0,
            sx: 1, sy: 1, sz: 1, asset: "ghost-tree",
            variantSeed: 1, seed: 1, attrs: {},
          },
        ],
        table,
      ),
    /unknown asset "ghost-tree"/,
  );
});

test("spawn table rejects bad version and empty asset ids", () => {
  assert.throws(() =>
    parseSpawnTableJSON({ version: 2, archetypes: {} }),
  );
  assert.throws(() =>
    parseSpawnTableJSON({
      version: 1,
      archetypes: { "": { asset: "" } },
    }),
  );
});
