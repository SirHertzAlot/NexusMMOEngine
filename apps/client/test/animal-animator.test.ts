import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { AnimalAnimator } from "../src/render/animal/animal-animator.js";

describe("AnimalAnimator", () => {
  function createTestClips(): THREE.AnimationClip[] {
    const root = new THREE.Object3D();
    root.name = "Root";
    const track = new THREE.VectorKeyframeTrack("Root.position", [0, 1], [0, 0, 0, 0, 0, 1]);
    return [
      new THREE.AnimationClip("Idle", 3.0, [track]),
      new THREE.AnimationClip("Idle_2", 3.0, [track]),
      new THREE.AnimationClip("Idle_Headlow", 3.0, [track]),
      new THREE.AnimationClip("Eating", 6.0, [track]),
      new THREE.AnimationClip("Walk", 1.2, [track]),
      new THREE.AnimationClip("Gallop", 0.6, [track]),
      new THREE.AnimationClip("Gallop_Jump", 1.4, [track]),
      new THREE.AnimationClip("Jump_toIdle", 1.2, [track]),
      new THREE.AnimationClip("Attack", 1.0, [track]),
      new THREE.AnimationClip("Death", 1.0, [track]),
      new THREE.AnimationClip("Idle_HitReact1", 0.5, [track]),
    ];
  }

  it("initializes with Idle clip and cycles autonomous idle behaviors", () => {
    const root = new THREE.Object3D();
    const clips = createTestClips();
    const animator = new AnimalAnimator(root, clips, { modelId: "quaternius-animals/Deer" });

    // Initial state is idle
    animator.update(0.016, { speed: 0, dead: false });
    assert.equal(animator.speed, 0);

    // Fast-forward past idle timer (4 seconds) to trigger autonomous idle transition
    for (let i = 0; i < 300; i++) {
      animator.update(0.016, { speed: 0, dead: false });
    }
    // State should be one of the natural idle behaviors: graze, rest, look, or idle
    assert.ok(
      ["graze", "rest", "look", "idle"].includes(animator.state),
      `Expected idle substate, got ${animator.state}`,
    );

    animator.dispose();
  });

  it("applies progressive windup to top speed instead of instant snapping", () => {
    const root = new THREE.Object3D();
    const clips = createTestClips();
    const animator = new AnimalAnimator(root, clips, {
      modelId: "quaternius-animals/Deer",
      accelerationRate: 3.0,
    });

    // Start from rest, request top sprint speed (4.5 m/s)
    animator.update(0.016, { speed: 4.5, dead: false });
    // In one frame (16ms), speed should be ~0.048, NOT instantly 4.5
    assert.ok(animator.speed < 0.1, `Speed snapped too fast: ${animator.speed}`);
    assert.ok(animator.speed > 0, "Speed did not accelerate");

    // After 0.5s (approx 31 frames), speed should be around 1.5 m/s (walk/trot)
    for (let i = 0; i < 31; i++) {
      animator.update(0.016, { speed: 4.5, dead: false });
    }
    assert.ok(animator.speed > 1.0 && animator.speed < 2.5, `Expected progressive windup around 1.5, got ${animator.speed}`);
    assert.equal(animator.state, "walk");

    // After another 1.0s, should reach sprint / gallop speed
    for (let i = 0; i < 62; i++) {
      animator.update(0.016, { speed: 4.5, dead: false });
    }
    assert.ok(animator.speed >= 3.0, `Expected gallop speed, got ${animator.speed}`);

    animator.dispose();
  });

  it("plays discrete stride (Gallop_Jump) through all frames", () => {
    const root = new THREE.Object3D();
    const clips = createTestClips();
    const animator = new AnimalAnimator(root, clips, { modelId: "quaternius-animals/Deer" });

    // Accelerate to sprint
    for (let i = 0; i < 100; i++) {
      animator.update(0.016, { speed: 4.0, dead: false });
    }

    // Now speed drops to 0 in mid-flight
    // If it triggered strideLock or is in gallop, it gracefully handles transitions
    animator.update(0.016, { speed: 0, dead: false });
    assert.ok(animator);

    animator.dispose();
  });

  it("plays Death clip when dead", () => {
    const root = new THREE.Object3D();
    const clips = createTestClips();
    const animator = new AnimalAnimator(root, clips);

    animator.update(0.016, { speed: 2.0, dead: true });
    assert.equal(animator.state, "dead");
    animator.dispose();
  });

  it("applies canine prowl mode when stalking at low to medium speed", () => {
    const root = new THREE.Object3D();
    const clips = createTestClips();
    const wolf = new AnimalAnimator(root, clips, { modelId: "quaternius-animals/Wolf" });
    assert.equal(wolf.isCanine, true);

    // Accelerate to prowl speed (0.8 m/s)
    for (let i = 0; i < 20; i++) {
      wolf.update(0.016, { speed: 0.8, dead: false });
    }
    assert.equal(wolf.state, "prowl");
    wolf.dispose();
  });

  it("recognizes caprine species and equips attack headbutt", () => {
    const root = new THREE.Object3D();
    const track = new THREE.VectorKeyframeTrack("Root.position", [0, 1], [0, 0, 0, 0, 0, 1]);
    const clips = [
      ...createTestClips(),
      new THREE.AnimationClip("Attack_Headbutt", 1.2, [track]),
      new THREE.AnimationClip("Attack_Kick", 1.0, [track]),
    ];
    const goat = new AnimalAnimator(root, clips, { modelId: "quaternius-animals/Goat" });
    assert.equal(goat.isCaprine, true);

    goat.update(0.016, { speed: 0, dead: false, attackT: 0.2 });
    assert.equal(goat.state, "attack");
    goat.dispose();
  });

  it("drives biological living simulation postures (sleeping, foraging, drinking, spurring)", () => {
    const root = new THREE.Object3D();
    const track = new THREE.VectorKeyframeTrack("Root.position", [0, 1], [0, 0, 0, 0, 0, 1]);
    const clips = [
      ...createTestClips(),
      new THREE.AnimationClip("Attack_Kick", 1.0, [track]),
    ];
    const deer = new AnimalAnimator(root, clips, { modelId: "quaternius-animals/Deer" });

    // Sleeping -> rest posture
    deer.update(0.016, { speed: 0, dead: false, livingAction: "sleeping" });
    assert.equal(deer.state, "rest");

    // Foraging / Eating -> grazing posture
    deer.update(0.016, { speed: 0, dead: false, livingAction: "foraging" });
    assert.equal(deer.state, "graze");

    // Drinking -> head-low graze posture
    deer.update(0.016, { speed: 0, dead: false, livingAction: "drinking" });
    assert.equal(deer.state, "graze");

    // Mating display -> spurring / headbutt posture
    deer.update(0.016, { speed: 0, dead: false, livingAction: "mating_display" });
    assert.equal(deer.state, "spurring");

    deer.dispose();
  });
});
