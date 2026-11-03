/** The committed stand-in map (no licensed art): each quadruped's model id is in the placeholder catalog the client reads. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadEnemyModels } from "../../src/enemy-models.js";

describe("placeholder enemy models", () => {
  it("gives the stand-in quadrupeds a model id that the placeholder catalog lists", () => {
    const map = new URL("../../../content/enemies/models.placeholder.json", import.meta.url);
    const catalogFile = new URL("../../../../../apps/client/public/placeholder-art/catalog.json", import.meta.url);
    const warnings: string[] = [];
    const models = loadEnemyModels(map, (m) => warnings.push(m), (kind) => ["wolf", "bear", "boar"].includes(kind));
    assert.deepEqual(warnings, []);
    assert.deepEqual(Object.keys(models).sort(), ["bear", "boar", "wolf"]);
    const catalog = JSON.parse(readFileSync(catalogFile, "utf8")) as { models: { id: string }[] };
    const ids = new Set(catalog.models.map((m) => m.id));
    for (const kind of ["bear", "boar", "wolf"]) {
      for (const id of models[kind]!) assert.ok(ids.has(id), `${kind}: ${id} is not in the placeholder catalog`);
    }
  });
});
