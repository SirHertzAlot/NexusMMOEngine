/**
 * EA21 client animation: the server's Animation row, planned by art's
 * `planClip`, drives a CharacterAnimator's layers on a procedural stand-in
 * rig (no licensed art): a gait is the base clip at the server's rate, an
 * upper-body clip leaves the legs to the motion, a one-shot plays over the
 * base, and changing clip crossfades.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClipId } from "@mmo-engine/protocol";
import {
  DEFAULT_CLIP_MAP,
  LAYER_BASE,
  LAYER_UPPER,
  buildStandIn,
  buildStandInClips,
  indexClipMap,
  planClip,
  standInClipInfo,
} from "@mmo-engine/art/browser";
import { LocomotionMode } from "@mmo-engine/protocol";
import { AnimationLibrary, CharacterAnimator, type Motion } from "../src/render/character/character-animator.js";

const map = indexClipMap(DEFAULT_CLIP_MAP);
const HZ = 30;
const still: Motion = { speed: 0, vy: 0, mode: LocomotionMode.Ground };
const jogging: Motion = { speed: 3.6, vy: 0, mode: LocomotionMode.Ground };

function setup(): CharacterAnimator {
  const clips = buildStandInClips();
  return new CharacterAnimator(buildStandIn().root, AnimationLibrary.of(clips, standInClipInfo(clips)));
}

const plan = (clipId: number, over: { startTick?: number; rate?: number; layerMask?: number } = {}, nowTick = 100) =>
  planClip({ clipId, startTick: 100, rate: 1, layerMask: LAYER_BASE, ...over }, map, nowTick, HZ);

/** Run `seconds` of frames. */
function run(a: CharacterAnimator, seconds: number, motion: Motion, p: ReturnType<typeof plan>): void {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) a.update(1 / 60, motion, p);
}

describe("CharacterAnimator driven by the server's Animation row", () => {
  it("plays the clip the row names as the base, whatever the motion says", () => {
    const a = setup();
    run(a, 0.1, still, plan(ClipId.Sprint));
    assert.equal(a.baseClip, "Sprint_Loop");
    run(a, 0.1, jogging, plan(ClipId.Walk));
    assert.equal(a.baseClip, "Walk_Loop");
  });

  it("falls back to the motion when there is no plan (clip 0)", () => {
    const a = setup();
    run(a, 0.1, jogging, null);
    assert.equal(a.baseClip, "Jog_Fwd_Loop");
    run(a, 0.1, still, plan(ClipId.None));
    assert.equal(a.baseClip, "Idle_Loop");
  });

  it("crossfades between clips: the new one fades in on eased weights, then the old one is gone", () => {
    const a = setup();
    run(a, 0.1, still, plan(ClipId.Idle));
    const fading = () => a.fading;
    assert.equal(fading(), null);
    a.update(1 / 60, still, plan(ClipId.Jog));
    assert.deepEqual([fading()?.from, fading()?.to], ["Idle_Loop", "Jog_Fwd_Loop"]);
    const early = fading()!.progress;
    run(a, 0.1, still, plan(ClipId.Jog));
    const mid = fading()!.progress;
    assert.ok(early < mid && mid < 1, `${early} < ${mid} < 1`);
    run(a, 0.3, still, plan(ClipId.Jog));
    assert.equal(fading(), null);
  });

  it("an upper-body clip plays as the action while the legs keep following the motion", () => {
    const a = setup();
    run(a, 0.1, jogging, plan(ClipId.AttackSwordA, { layerMask: LAYER_UPPER }));
    assert.equal(a.action, "Sword_Regular_A");
    assert.equal(a.baseClip, "Jog_Fwd_Loop");
  });

  it("does not restart an action every frame, but does for a repeat of the same clip", () => {
    const a = setup();
    const first = plan(ClipId.AttackSwordA, { layerMask: LAYER_UPPER, startTick: 100 }, 100);
    a.update(1 / 60, still, first);
    run(a, 0.2, still, plan(ClipId.AttackSwordA, { layerMask: LAYER_UPPER, startTick: 100 }, 106));
    const t = a["layer"]!.time;
    assert.ok(t > 0.15, `kept playing (${t})`);
    run(a, 1 / 60, still, plan(ClipId.AttackSwordA, { layerMask: LAYER_UPPER, startTick: 130 }, 130));
    assert.ok(a["layer"]!.time < t, "restarted");
  });

  it("starts a late action where it would be (the playhead follows the start tick)", () => {
    const a = setup();
    // 9 ticks (0.3 s) after the server started it.
    a.update(1 / 60, still, plan(ClipId.AttackSwordB, { layerMask: LAYER_UPPER }, 109));
    const t = a["layer"]!.time;
    assert.ok(t > 0.29 && t < 0.33, `time ${t}`);
  });

  it("plays a base one-shot (a hit) whole-body over the locomotion", () => {
    const a = setup();
    run(a, 0.1, jogging, plan(ClipId.Hit));
    assert.equal(a.action, "Hit_Reaction");
    assert.equal(a.baseClip, "Jog_Fwd_Loop");
    assert.equal(a["layer"]!.opts.mask, "full");
  });

  it("the server's rate scales the gait", () => {
    const a = setup();
    run(a, 0.1, still, plan(ClipId.Walk, { rate: 1.75 }));
    assert.equal(a["base"]!.action.timeScale, 1.75);
  });

  it("swimming and being airborne stay with the motion (the server never sends those clips)", () => {
    const a = setup();
    run(a, 0.1, { speed: 1, vy: 0, mode: LocomotionMode.Swim }, plan(ClipId.Walk));
    assert.equal(a.baseClip, "Swim_Fwd_Loop");
    const b = setup();
    run(b, 0.3, { speed: 1, vy: 5, mode: LocomotionMode.Ground }, plan(ClipId.Walk));
    assert.equal(b.baseClip, "Jump_Loop");
  });

  it("ends the server's action when the server goes back to a gait, but leaves a roll the game started", () => {
    const a = setup();
    run(a, 0.1, still, plan(ClipId.AttackSwordA, { layerMask: LAYER_UPPER }));
    assert.equal(a.action, "Sword_Regular_A");
    run(a, 0.05, still, plan(ClipId.Idle));
    assert.equal(a.action, null);
    // A roll played from the Action row is not the server clip's to stop.
    run(a, 0.05, still, plan(ClipId.AttackSwordA, { layerMask: LAYER_UPPER, startTick: 140 }, 140));
    a.play("Hit_Reaction");
    run(a, 0.05, still, plan(ClipId.Idle));
    assert.equal(a.action, "Hit_Reaction");
  });

  it("an unknown clip name in the map plays nothing and changes nothing", () => {
    const a = setup();
    run(a, 0.1, still, plan(ClipId.Idle));
    const bad = planClip({ clipId: 77, startTick: 100, rate: 1, layerMask: LAYER_BASE }, indexClipMap({ version: 1, clips: [{ id: 77, name: "x", clip: "Nope", loop: true, fade: 0.1 }] }), 100, HZ);
    run(a, 0.1, still, bad);
    assert.equal(a.baseClip, "Idle_Loop");
  });
});
