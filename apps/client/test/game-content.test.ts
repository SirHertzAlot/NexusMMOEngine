/** Animation-side content in the client: the shipped documents apply, a bad one is skipped, footsteps follow the surface. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MEDIA_DOCS, MEDIA_DOC_NAMES, type GameContent } from "@mmo-engine/art/browser";
import { combatMove, Move } from "@mmo-engine/protocol";
import { applyGameContent, gameContent } from "../src/render/game-content.js";
import { getLocomotion } from "../src/render/character/character-animator.js";
import { withSurfaceMaterials, type SurfaceManifest } from "../src/render/terrain/surfaces.js";
import { FOOTSTEP_FALLBACK, Footsteps, footstepEvent, footstepStride } from "../src/audio/footsteps.js";

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

  it("an edit reaches the code that plays it: hit frame, crossfade, surface tint", () => {
    const c = content();
    c.combat!.moves.find((m) => m.id === Move.SwordB)!.hitAt = 0.31;
    c.animation!.locomotion.fade = 0.45;
    c.materials!.surfaces.grass.tint = [0.5, 0.6, 0.7];
    applyGameContent(c);
    assert.equal(combatMove(Move.SwordB)!.hitAt, 0.31);
    assert.equal(getLocomotion()!.fade, 0.45);
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
    assert.equal(getLocomotion()!.fade, 0.33);
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

  it("the sound follows the biome's surface, else the plain footstep event", () => {
    const m = content().materials;
    assert.equal(footstepEvent("plains", m), "footstep-grass");
    assert.equal(footstepEvent("mountains", m), "footstep-stone");
    assert.equal(footstepEvent("desert", m), FOOTSTEP_FALLBACK, "a surface with no footstep of its own");
    assert.equal(footstepEvent(null, m), FOOTSTEP_FALLBACK);
    assert.equal(footstepEvent("nowhere", undefined), FOOTSTEP_FALLBACK);
    assert.equal(footstepStride(m), 1.7);
    assert.equal(footstepStride(undefined), 1.7);
  });
});
