/**
 * Player input → PlayerIntent fields (docs/MESSAGE-CATALOG.md §0x05).
 *
 * InputState is DOM-free and unit-testable: the App binds DOM listeners
 * and forwards them. WASD/arrows drive wish-move in world space (rotated
 * by look yaw), mouse drag orbits the camera and writes look yaw/pitch.
 * Space jumps, and swims or flies up (my = +1); C swims or flies down
 * (my = -1); F toggles flight (for characters that can fly — the server
 * decides).
 *
 * Convention (matches the third-person follow camera, follow-camera.ts): forward =
 * (sin(yaw), 0, cos(yaw)), right = (-cos(yaw), 0, sin(yaw)). At yaw 0,
 * D maps to world -X, which is camera-right because the camera sits at
 * -Z looking toward +Z. Wish-move is normalized so diagonal movement
 * isn't faster.
 */

import { IntentButton, type IntentFields } from "@mmo-engine/protocol";

const SENSITIVITY = 0.0025; // radians per mouse pixel
const PITCH_LIMIT = 1.2; // ~69 degrees

// Whitelist movement keys to prevent inventory/UI keys from marking movement intent as dirty
const MOVEMENT_KEYS = new Set([
  "KeyW", "ArrowUp",
  "KeyS", "ArrowDown",
  "KeyA", "ArrowLeft",
  "KeyD", "ArrowRight",
  "Space", // jump; up when swimming or flying
  "KeyC", // down when swimming or flying
  "KeyF", // toggle flight
]);

/**
 * Keys whose press the server acts on (jump, flight toggle). A press is
 * latched until an intent has carried it: at a low frame rate a key can
 * go down and up between two reads, and would otherwise never be sent.
 */
const PRESS_KEYS = new Set(["Space", "KeyF"]);

export class InputState {
  lookYaw = 0;
  lookPitch = 0;
  private readonly keys = new Set<string>();
  /** Presses not yet carried by an intent (see PRESS_KEYS). */
  private readonly pressed = new Set<string>();
  /** Set when the intent vector changed since the last read. */
  private dirty = true;

  keyDown(code: string): void {
    if (MOVEMENT_KEYS.has(code) && !this.keys.has(code)) {
      this.keys.add(code);
      if (PRESS_KEYS.has(code)) this.pressed.add(code);
      this.dirty = true;
    }
  }

  keyUp(code: string): void {
    if (this.keys.delete(code)) this.dirty = true;
  }

  /** Clear all keys immediately if the browser loses focus to prevent stuck "ghost" inputs. */
  clear(): void {
    if (this.keys.size > 0 || this.pressed.size > 0) {
      this.keys.clear();
      this.pressed.clear();
      this.dirty = true;
    }
  }

  /** Mouse-look delta in pixels (call from a pointermove handler). */
  addLookDelta(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;

    this.lookYaw -= dx * SENSITIVITY;
    this.lookPitch = Math.max(
      -PITCH_LIMIT,
      Math.min(PITCH_LIMIT, this.lookPitch - dy * SENSITIVITY),
    );
    this.dirty = true;
  }

  /** True when the intent changed since the last toIntent() call. */
  consumeDirty(): boolean {
    const d = this.dirty;
    this.dirty = false;
    return d;
  }

  toIntent(): IntentFields {
    const held = this.keys;
    // A latched press reads as held this once; if the key is already up,
    // the next read sends the release.
    const k = this.pressed.size > 0 ? new Set([...held, ...this.pressed]) : held;
    for (const code of this.pressed) if (!held.has(code)) this.dirty = true;
    this.pressed.clear();
    const fwd = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) -
      (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    const strafe = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) -
      (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);

    const lx = strafe;
    const lz = fwd;

    // Performance optimization: Replace heavy Math.hypot with simple conditions on hot paths
    const isDiagonal = lx !== 0 && lz !== 0;
    const len = isDiagonal ? 1.41421356237 : 1;

    const hasMovement = lx !== 0 || lz !== 0;
    const nx = hasMovement ? lx / len : 0;
    const nz = hasMovement ? lz / len : 0;

    const cos = Math.cos(this.lookYaw);
    const sin = Math.sin(this.lookYaw);

    const mx = -nx * cos + nz * sin;
    const mz = nx * sin + nz * cos;

    return {
      // +0 normalizes -0 to +0: with no keys held the rotation math can
      // yield -0 at some yaws (e.g. -0*cos + 0*sin), which is harmless on
      // the wire but noise in the protocol (deepStrictEqual distinguishes
      // -0 from +0).
      mx: mx + 0,
      // Up/down wish for swimming and flight; on the ground the server
      // ignores it (jump is the jump flag).
      my: (k.has("Space") ? 1 : 0) - (k.has("KeyC") ? 1 : 0),
      mz: mz + 0,
      lookYaw: this.lookYaw,
      lookPitch: this.lookPitch,
      buttons: k.has("KeyF") ? IntentButton.ToggleFlight : 0,
      jump: k.has("Space"),
    };
  }
}

/**
 * Bind DOM listeners for one canvas element. Returns an unbind function.
 * Pointer lock on click gives raw mouse-look; Esc releases it (browser).
 * Window blur clears held keys so alt-tabbing can't leave ghost inputs.
 */
export function bindInput(
  el: HTMLElement,
  input: InputState,
  opts: { onFirstInteraction?: () => void } = {},
): () => void {
  let interacted = false;

  const interact = (): void => {
    if (!interacted) {
      interacted = true;
      opts.onFirstInteraction?.();
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    interact();
    // Space and arrows would otherwise scroll the page.
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
    input.keyDown(e.code);
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    input.keyUp(e.code);
  };

  const onClick = (): void => {
    interact();
    el.requestPointerLock?.();
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (document.pointerLockElement === el) {
      input.addLookDelta(e.movementX, e.movementY);
    }
  };

  const onWindowBlur = (): void => {
    input.clear();
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onWindowBlur);
  el.addEventListener("click", onClick);
  document.addEventListener("mousemove", onMouseMove);

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onWindowBlur);
    el.removeEventListener("click", onClick);
    document.removeEventListener("mousemove", onMouseMove);
  };
}
