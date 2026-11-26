/**
 * The viewport's visual table (roadmap EB1).
 *
 * The point of these assertions is that the editor is not inventing sizes.
 * A creature's capsule has to be the capsule the engine spawns — the same
 * `CHARACTER_CAPSULE` times the same body scale `CreatureService` resolves,
 * including its "a creature's own behavior.size wins, unless it is 1" rule —
 * and a prop's stand-in has to move with the scale document the server
 * applies. If either drifts, the viewport lies about the world, which is
 * worse than the grey cube it replaced.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { DEFAULT_SCALE, type ScaleDoc } from "@mmo-engine/scene";
import {
  buildVisuals,
  creatureBodyScale,
  creatureVisual,
  propVisual,
  visualFor,
  visualKeys,
  STAND_IN_SIZE,
  type VisualsInput,
} from "../src/scene-visuals.js";
import { handleSceneVisualsRoute, readSceneVisuals, readScaleDoc } from "../src/scene-visuals-host.js";

const CAPSULE = { radius: 0.35, halfHeight: 0.55 };

function input(over: Partial<VisualsInput> = {}): VisualsInput {
  return {
    creatures: { goblin: {}, wolf: {}, dragon: { behavior: { size: 4 } }, ox: { behavior: { size: 1 } } },
    naturalScale: { wolf: 0.35, ox: 0.4 },
    capsule: CAPSULE,
    archetypes: { oak: { category: "tree" }, crate: {}, longhouse: { category: "building" } },
    scale: DEFAULT_SCALE,
    model: () => null,
    ...over,
  };
}

describe("creature body scale", () => {
  const i = input();
  it("takes the creature's own size when it sets one", () => {
    assert.equal(creatureBodyScale("dragon", i.creatures, i.naturalScale), 4);
  });
  it("ignores a size of 1 and uses the species' natural scale, as the engine does", () => {
    assert.equal(creatureBodyScale("ox", i.creatures, i.naturalScale), 0.4);
  });
  it("falls back to the natural scale, then to 1 for an unlisted humanoid", () => {
    assert.equal(creatureBodyScale("wolf", i.creatures, i.naturalScale), 0.35);
    assert.equal(creatureBodyScale("goblin", i.creatures, i.naturalScale), 1);
  });
});

describe("a creature's capsule", () => {
  it("is the engine's capsule: 1.8 m for an unscaled humanoid", () => {
    const v = creatureVisual("goblin", input());
    assert.equal(v.shape, "capsule");
    assert.deepEqual(v.size, [0.7, 1.8, 0.7]);
    assert.equal(v.factor, 1);
    assert.equal(v.basis, "capsule");
  });
  it("shrinks with the species' natural scale", () => {
    const v = creatureVisual("wolf", input());
    assert.deepEqual(v.size, [0.245, 0.63, 0.245]);
    assert.equal(v.factor, 0.35);
    assert.match(v.note, /0\.63 m tall/);
  });
  it("reports the pack's model when there is one, and still carries the body scale", () => {
    const v = creatureVisual("wolf", input({ model: (id) => `/assets/models/${id}.glb` }));
    assert.equal(v.model, "/assets/models/wolf.glb");
    assert.equal(v.basis, "model");
    assert.equal(v.factor, 0.35);
  });
});

describe("a prop's stand-in", () => {
  it("is its category's size when the scale document is neutral", () => {
    const v = propVisual("oak", "tree", input());
    assert.equal(v.shape, "box");
    assert.deepEqual(v.size, [...STAND_IN_SIZE.tree]);
    assert.equal(v.basis, "stand-in");
    assert.match(v.note, /no model yet/);
  });
  it("moves with the scale document, category and asset together", () => {
    const scale: ScaleDoc = { version: 1, global: 2, categories: { building: 1.5 }, assets: { longhouse: 0.5 } };
    const v = propVisual("longhouse", "building", input({ scale }));
    assert.equal(v.factor, 1.5);
    assert.deepEqual(v.size, [12, 7.5, 12]);
  });
});

describe("the table", () => {
  it("covers every creature and archetype, and defaults an unlabelled archetype to a prop", () => {
    const t = buildVisuals(input());
    assert.deepEqual(Object.keys(t).sort(), ["crate", "dragon", "goblin", "longhouse", "oak", "ox", "wolf"]);
    assert.deepEqual(t.crate.size, [...STAND_IN_SIZE.prop]);
  });
  it("lets a creature win an id clash, as the scene spawner does", () => {
    const t = buildVisuals(input({ archetypes: { goblin: { category: "rock" } } }));
    assert.equal(t.goblin.shape, "capsule");
  });
  it("ignores a category the scale document does not have", () => {
    const t = buildVisuals(input({ archetypes: { weird: { category: "spaceship" } } }));
    assert.deepEqual(t.weird.size, [...STAND_IN_SIZE.prop]);
  });
});

describe("naming a node's visual", () => {
  it("tries the spawner's creature, the prefab, its last segment, then the species", () => {
    assert.deepEqual(
      visualKeys({ prefab: "camps/goblin", components: { Spawner: { creature: "orc", species: "wolf" } } }),
      ["orc", "camps/goblin", "goblin", "wolf"],
    );
  });
  it("drops empties and repeats", () => {
    assert.deepEqual(visualKeys({ prefab: "oak" }), ["oak"]);
    assert.deepEqual(visualKeys({}), []);
  });
  it("takes the first key the table knows", () => {
    const t = buildVisuals(input());
    const node = { prefab: "camps/goblin" };
    assert.equal(visualFor(node, t)?.shape, "capsule");
    assert.equal(visualFor({ prefab: "nothing-like-this" }, t), null);
  });
});

describe("the host's reading", () => {
  // This file runs compiled, from apps/editor/dist/test.
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  it("builds the real repository's table from the engine's own tables", () => {
    const { visuals } = readSceneVisuals(repoRoot);
    assert.equal(visuals.goblin?.shape, "capsule", "the roster's goblin is a creature");
    assert.deepEqual(visuals.goblin?.size, [0.7, 1.8, 0.7], "and stands 1.8 m, like a character");
    assert.ok(visuals.wolf, "the roster's wolf is in the table");
    assert.ok(visuals.wolf.size[1] < visuals.goblin.size[1], "a wolf is shorter than a goblin");
    assert.equal(visuals.oak?.shape, "box", "the spawn table's oak is a prop");
  });
  it("reads content/scale.json, and falls back to the default document", () => {
    assert.equal(readScaleDoc(repoRoot).version, 1);
    assert.deepEqual(readScaleDoc("/nonexistent-repo-root"), DEFAULT_SCALE);
  });
  it("answers GET only, and nothing on another path", () => {
    assert.equal(handleSceneVisualsRoute(repoRoot, "GET", "/api/editor/content/placeables"), null);
    assert.equal(handleSceneVisualsRoute(repoRoot, "POST", "/api/editor/scene/visuals")?.status, 405);
    const ok = handleSceneVisualsRoute(repoRoot, "GET", "/api/editor/scene/visuals");
    assert.equal(ok?.status, 200);
    assert.equal((ok?.body as { ok: boolean }).ok, true);
  });
});
