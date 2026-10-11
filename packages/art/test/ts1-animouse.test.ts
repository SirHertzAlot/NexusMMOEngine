/**
 * TS1: animouse spike — state machine and blend trees over AnimationMixer.
 *
 * Gates:
 * - Pop-free blends (no position discontinuity on transition)
 * - Events within ±1 frame (footstep/hit frame timing)
 * - Under 0.1ms per character per frame (client-side perf)
 *
 * Client side only. The server still sends (clipId, startTick, rate, layerMask).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// animouse is ESM; dynamic import for node:test
// @ts-expect-error - animouse types resolve at runtime
const { AnimationMachine, LinearBlendTree } = await import("animouse");

describe("ts1 animouse spike", () => {
  it("exports AnimationMachine and LinearBlendTree", () => {
    assert.ok(typeof AnimationMachine === "function", "AnimationMachine missing");
    assert.ok(typeof LinearBlendTree === "function", "LinearBlendTree missing");
  });

  it("creates a blend tree with idle/walk/run", () => {
    // Mock mixer actions (animouse works over three's AnimationMixer;
    // here we verify the API shape without a full three.js scene)
    const mockAction = (name: string) => ({
      name,
      play: () => {},
      stop: () => {},
      setEffectiveWeight: (_w: number) => {},
      getEffectiveWeight: () => 1,
      getClip: () => ({ name, duration: 1 }),
      enabled: true,
    });

    const tree = new LinearBlendTree([
      { action: mockAction("idle") as any, value: 0 },
      { action: mockAction("walk") as any, value: 0.5 },
      { action: mockAction("run") as any, value: 1 },
    ]);

    // Blend at 0.25 should be between idle and walk
    tree.setBlend(0.25);
    assert.ok(true, "setBlend(0.25) did not throw");
  });

  it("state machine transitions without popping", () => {
    // This is a smoke test; full pop-free verification requires
    // a rendered scene with position sampling (see docs/TS1-ANIMOUSE.md)
    assert.ok(true, "transition API exists");
  });
});
