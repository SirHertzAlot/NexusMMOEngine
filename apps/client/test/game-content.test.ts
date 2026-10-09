/** Media content in the client: the shipped documents apply, a bad one is skipped, and footsteps follow the surface. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MEDIA_DOCS, MEDIA_DOC_NAMES, type GameContent } from "@mmo-engine/art/browser";
import { combatMove, Move } from "@mmo-engine/protocol";
import { applyGameContent, gameContent } from "../src/render/game-content.js";
import { getLocomotion } from "../src/render/character/character-animator.js";
import { QUALITY_PRESETS } from "../src/render/quality.js";
import { PARTICLE_PRESETS } from "../src/render/vfx/quarks-fx.js";
import { withSurfaceMaterials, type SurfaceManifest } from "../src/render/terrain/surfaces.js";
import { Footsteps, footstepEvent } from "../src/audio/footsteps.js";

const content = (): GameContent =>
  Object.fromEntries(
    MEDIA_DOC_NAMES.map((n) => [n, JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../content/${MEDIA_DOCS[n].file}`, import.meta.url)), "utf8"))]),
  ) as GameContent;

describe("game content", () => {
  it("the shipped documents all apply", () => {
    const r = applyGameContent(content());
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.applied.sort(), [...MEDIA_DOC_NAMES].sort());
  });

  it("an edit reaches the code that plays it: hit frame, crossfade, particle rate, tier budget, surface tint", () => {
    const c = content();
    c.combat!.moves.find((m) => m.id === Move.SwordB)!.hitAt = 0.31;
    c.animation!.locomotion.fade = 0.45;
    c.vfx!.effects.embers.rate = 33;
    c.tiers!.tiers.low.effectBudget = 99;
    c.materials!.surfaces.grass.tint = [0.5, 0.6, 0.7];
    applyGameContent(c);
    assert.equal(combatMove(Move.SwordB)!.hitAt, 0.31);
    assert.equal(getLocomotion().fade, 0.45);
    assert.equal(PARTICLE_PRESETS.embers.rate, 33);
    assert.equal(QUALITY_PRESETS.low.effectBudget, 99);
    const manifest = { layers: [{ id: "grass", tint: [1, 1, 1], tileMetres: 4 }] } as unknown as SurfaceManifest;
    assert.deepEqual(withSurfaceMaterials(manifest).layers[0].tint, [0.5, 0.6, 0.7]);
    assert.equal(withSurfaceMaterials(manifest).layers[0].tileMetres, 4);
  });

  it("a document with problems is skipped and named; the rest still apply", () => {
    applyGameContent(content());
    const c = content();
    c.combat!.moves[0].hitAt = 50;
    c.animation!.locomotion.fade = 0.33;
    const r = applyGameContent(c);
    assert.ok(r.problems.some((p) => p.includes("combat/moves.json") && p.includes("moves[0].hitAt")));
    assert.ok(!r.applied.includes("combat"));
    assert.ok(r.applied.includes("animation"));
    assert.equal(combatMove(Move.SwordA)!.hitAt, 0.2, "the moves in force are untouched");
    assert.equal(getLocomotion().fade, 0.33);
    assert.equal(gameContent().combat, undefined);
  });
});

describe("footsteps", () => {
  it("steps once per stride on the ground, not in the air or standing still", () => {
    const f = new Footsteps();
    let steps = 0;
    for (let i = 0; i < 100; i++) if (f.step(0.1, 3.4, true, 1.7)) steps++;
    assert.ok(steps >= 19 && steps <= 21, `${steps} steps in 34 m`);
    const air = new Footsteps();
    assert.ok(!Array.from({ length: 50 }, () => air.step(0.1, 5, false, 1.7)).some(Boolean));
    const still = new Footsteps();
    assert.ok(!Array.from({ length: 50 }, () => still.step(0.1, 0, true, 1.7)).some(Boolean));
  });

  it("the sound follows the biome's surface, else the fallback", () => {
    const c = content();
    assert.equal(footstepEvent("desert", c.materials, c.audio!), "step.sand");
    assert.equal(footstepEvent("mountains", c.materials, c.audio!), "step.rock");
    assert.equal(footstepEvent("glacier", c.materials, c.audio!), "step.snow");
    assert.equal(footstepEvent(null, c.materials, c.audio!), c.audio!.hooks.footstep.fallback);
    assert.equal(footstepEvent("nowhere", undefined, c.audio!), c.audio!.hooks.footstep.fallback);
  });
});
