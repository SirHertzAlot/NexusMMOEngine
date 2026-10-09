/**
 * File > New Scene / Open Scene, from any workspace: the menu asks, the
 * Scenes panel does it. A command sent while the panel is not mounted
 * (the menu first switches workspace) waits for it.
 */

export type SceneCommand = { kind: "new" } | { kind: "open"; name: string };

let pending: SceneCommand | null = null;
let handler: ((c: SceneCommand) => void) | null = null;

export function requestSceneCommand(c: SceneCommand): void {
  if (handler) handler(c);
  else pending = c;
}

/** The Scenes panel registers while mounted; returns the function that unregisters it. */
export function onSceneCommand(h: (c: SceneCommand) => void): () => void {
  handler = h;
  if (pending) {
    const c = pending;
    pending = null;
    h(c);
  }
  return () => {
    if (handler === h) handler = null;
  };
}
