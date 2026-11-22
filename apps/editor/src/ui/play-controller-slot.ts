/**
 * The live play-mode controller, on its own.
 *
 * It used to be a module-level `let` in ui/play-mode.tsx, beside the
 * debug dock — so anything that merely wanted to ASK the running server
 * something (the profiler's timings query) dragged the whole 3D client,
 * `@mmo-engine/client/render` and `/debug`, in behind it. The slot lives
 * here instead; play-mode.tsx sets it while the debugger is mounted and
 * re-exports the getter, so no existing importer changed.
 */

import type { PlayModeController } from "../play-mode.js";

let shared: PlayModeController | null = null;

/** The controller of the running play session, or null when none runs. */
export function getPlayController(): PlayModeController | null {
  return shared;
}

/** Claim the slot. The returned function releases it, unless a newer
 *  controller has taken it meanwhile. */
export function setPlayController(controller: PlayModeController): () => void {
  shared = controller;
  return () => {
    if (shared === controller) shared = null;
  };
}
