/**
 * InputState: WASD → wish-move vector math, look clamping, and the
 * production input hygiene rules (key whitelist, ghost-key clearing,
 * auto-repeat guards, -0 normalization).
 *
 * Locks the camera convention: yaw = 0 faces world +Z (matching
 * the follow camera rig), forward = (sin yaw, 0, cos yaw),
 * right = (-cos yaw, 0, sin yaw) — the camera sits at -Z looking +Z,
 * so its right hand points at world -X.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IntentButton } from "@mmo-engine/protocol";
import { InputState, isTextField } from "../src/input/input.js";
import { DEFAULT_BINDINGS } from "../src/input/bindings.js";

function withKeys(...codes: string[]): InputState {
  const input = new InputState();
  for (const c of codes) input.keyDown(c);
  return input;
}

describe("InputState.toIntent", () => {
  it("maps W to world +Z, S to -Z, D to world -X, A to world +X at yaw 0", () => {
    const w = withKeys("KeyW").toIntent();
    assert.deepEqual([w.mx, w.mz], [0, 1]);
    const s = withKeys("KeyS").toIntent();
    assert.deepEqual([s.mx, s.mz], [0, -1]);
    const d = withKeys("KeyD").toIntent();
    assert.deepEqual([d.mx, d.mz], [-1, 0]);
    const a = withKeys("KeyA").toIntent();
    assert.deepEqual([a.mx, a.mz], [1, 0]);
  });

  it("rotates wish-move with look yaw (yaw=π/2: W faces +X)", () => {
    const input = withKeys("KeyW");
    input.addLookDelta(-Math.PI / 2 / 0.0025, 0); // yaw += π/2
    const intent = input.toIntent();
    assert.ok(Math.abs(intent.lookYaw - Math.PI / 2) < 1e-9);
    assert.ok(Math.abs(intent.mx - 1) < 1e-9, `mx=${intent.mx}`);
    assert.ok(Math.abs(intent.mz - 0) < 1e-9, `mz=${intent.mz}`);
  });

  it("normalizes diagonal movement", () => {
    const intent = withKeys("KeyW", "KeyD").toIntent();
    const len = Math.hypot(intent.mx, intent.mz);
    assert.ok(Math.abs(len - 1) < 1e-9, `len=${len}`);
  });

  it("clamps pitch and tracks jump", () => {
    const input = withKeys();
    input.addLookDelta(0, -100000); // huge upward look
    assert.ok(input.toIntent().lookPitch <= 1.2 + 1e-9);
    input.keyDown("Space");
    assert.equal(input.toIntent().jump, true);
    input.keyUp("Space");
    assert.equal(input.toIntent().jump, false);
  });

  it("never emits -0 for mx/mz at any yaw, moving or idle", () => {
    for (const yaw of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 2, (-3 * Math.PI) / 4, 2.1, -1.7]) {
      for (const keys of [[], ["KeyW"], ["KeyD"], ["KeyW", "KeyA"]] as string[][]) {
        const input = withKeys(...keys);
        input.lookYaw = yaw;
        const intent = input.toIntent();
        assert.ok(!Object.is(intent.mx, -0), `mx=-0 at yaw=${yaw} keys=${keys}`);
        assert.ok(!Object.is(intent.mz, -0), `mz=-0 at yaw=${yaw} keys=${keys}`);
      }
    }
  });
});

describe("InputState hygiene", () => {
  it("ignores non-movement keys: KeyI enters no state and sets no dirty", () => {
    const input = new InputState();
    assert.equal(input.consumeDirty(), true); // initial dirty
    input.keyDown("KeyI");
    input.keyUp("KeyI");
    assert.equal(input.consumeDirty(), false);
    const intent = input.toIntent();
    assert.deepEqual([intent.mx, intent.mz], [0, 0]);
  });

  it("clear() drops ghost keys, resets jump, and marks dirty only when something was held", () => {
    const input = withKeys("KeyW", "KeyA");
    input.keyDown("Space");
    assert.equal(input.consumeDirty(), true);
    input.clear();
    assert.equal(input.consumeDirty(), true); // something was held
    const intent = input.toIntent();
    assert.deepEqual([intent.mx, intent.mz], [0, 0]);
    assert.equal(intent.jump, false);
    // Nothing held: clear() is a no-op for dirty.
    input.clear();
    assert.equal(input.consumeDirty(), false);
  });

  it("auto-repeat keyDown does not re-mark dirty", () => {
    const input = new InputState();
    assert.equal(input.consumeDirty(), true); // initial
    input.keyDown("KeyW");
    assert.equal(input.consumeDirty(), true);
    input.keyDown("KeyW"); // OS auto-repeat
    assert.equal(input.consumeDirty(), false);
    input.keyUp("KeyW");
    assert.equal(input.consumeDirty(), true);
    input.keyUp("KeyW"); // duplicate release
    assert.equal(input.consumeDirty(), false);
  });

  it("Space rising edge: jump latches on first keyDown, survives repeats, clears on keyUp", () => {
    const input = new InputState();
    assert.equal(input.consumeDirty(), true); // initial
    input.keyDown("Space");
    assert.equal(input.toIntent().jump, true);
    assert.equal(input.consumeDirty(), true);
    input.keyDown("Space"); // auto-repeat: no new edge
    assert.equal(input.toIntent().jump, true);
    assert.equal(input.consumeDirty(), false);
    input.keyUp("Space");
    assert.equal(input.toIntent().jump, false);
    assert.equal(input.consumeDirty(), true);
  });

  it("Space and C are the up/down axis (swimming, flight); F holds the flight toggle", () => {
    const input = new InputState();
    assert.deepEqual([input.toIntent().my, input.toIntent().buttons], [0, 0]);
    input.keyDown("Space");
    assert.equal(input.toIntent().my, 1);
    input.keyDown("KeyC");
    assert.equal(input.toIntent().my, 0, "both held cancel out");
    input.keyUp("Space");
    assert.equal(input.toIntent().my, -1);
    assert.equal(input.toIntent().jump, false, "C never jumps");
    input.keyDown("KeyF");
    assert.equal(input.toIntent().buttons, IntentButton.ToggleFlight);
    input.clear();
    assert.deepEqual([input.toIntent().my, input.toIntent().buttons], [0, 0]);
  });

  it("a press shorter than a frame still reaches one intent, then the release", () => {
    const input = new InputState();
    input.consumeDirty();
    input.keyDown("KeyF");
    input.keyUp("KeyF"); // released before the next frame read the input
    assert.equal(input.consumeDirty(), true);
    assert.equal(input.toIntent().buttons, IntentButton.ToggleFlight, "the press is sent");
    assert.equal(input.consumeDirty(), true, "and the release follows");
    assert.equal(input.toIntent().buttons, 0);
    input.keyDown("Space");
    input.keyUp("Space");
    input.consumeDirty();
    assert.equal(input.toIntent().jump, true, "a quick tap still jumps");
    assert.equal(input.toIntent().jump, false);
    input.keyDown("KeyF");
    input.clear(); // window blur: nothing latched survives
    assert.equal(input.toIntent().buttons, 0);
  });

  it("reports dirty only when input changed", () => {
    const input = withKeys("KeyW");
    assert.equal(input.consumeDirty(), true);
    assert.equal(input.consumeDirty(), false);
    input.addLookDelta(1, 0);
    assert.equal(input.consumeDirty(), true);
    input.addLookDelta(0, 0); // no-op delta: no dirty
    assert.equal(input.consumeDirty(), false);
  });
});

describe("InputState combat buttons", () => {
  it("left mouse attacks, right mouse guards while held, Q dodges", () => {
    const s = new InputState();
    s.keyDown("Mouse2");
    assert.equal(s.toIntent().buttons, IntentButton.Block);
    s.keyDown("Mouse0");
    s.keyDown("KeyQ");
    assert.equal(s.toIntent().buttons, IntentButton.Block | IntentButton.Attack | IntentButton.Dodge);
    s.keyUp("Mouse2");
    assert.equal(s.toIntent().buttons, IntentButton.Attack | IntentButton.Dodge);
  });

  it("a click too quick for one frame still reaches the server as a press", () => {
    const s = new InputState();
    s.keyDown("Mouse0");
    s.keyUp("Mouse0");
    assert.equal(s.toIntent().buttons, IntentButton.Attack, "latched until an intent carries it");
    assert.equal(s.toIntent().buttons, 0, "then released");
  });
});

describe("InputState interface keys (M3a)", () => {
  it("E picks up and B opens the bag by default; neither moves the character", () => {
    const input = new InputState();
    assert.equal(input.uiActionFor("KeyE"), "interact");
    assert.equal(input.uiActionFor("KeyB"), "bag");
    assert.equal(input.uiActionFor("KeyR"), "technique", "R: next technique (M3)");
    assert.equal(input.uiActionFor("KeyT"), "aim", "T: next aim (M3)");
    assert.equal(input.uiActionFor("KeyH"), "treat", "H: treat your worst wound (M4)");
    assert.equal(input.uiActionFor("KeyW"), null);
    input.consumeDirty();
    input.keyDown("KeyE");
    input.keyDown("KeyB");
    assert.equal(input.consumeDirty(), false, "interface keys never mark the intent dirty");
  });

  it("follows rebinding", () => {
    const input = new InputState();
    const b = structuredClone(DEFAULT_BINDINGS);
    b.interact = ["KeyG"];
    input.setBindings(b);
    assert.equal(input.uiActionFor("KeyG"), "interact");
    assert.equal(input.uiActionFor("KeyE"), null);
  });

  it("treats nothing as a text field outside the browser", () => {
    assert.equal(isTextField(null), false);
  });
});
