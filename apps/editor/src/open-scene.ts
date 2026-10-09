/**
 * The scene open in the Scenes workspace, shared outside React: Play mode
 * reads it to boot the server with the open (possibly unsaved) document
 * (EA6), and the Scenes panel writes it on every change.
 */

import type { SceneDoc } from "@mmo-engine/scene";

export interface OpenScene {
  name: string;
  doc: SceneDoc;
}

let current: OpenScene | null = null;

export const openScene = {
  get: (): OpenScene | null => current,
  set: (next: OpenScene | null): void => {
    current = next;
  },
};

/** The open scene if a server can run it (frontend scenes are client-only). */
export function playableScene(): OpenScene | null {
  return current && current.doc.kind !== "frontend" ? current : null;
}

// "New Scene…" from the File menu: the Scenes panel may not be mounted yet, so
// the request waits here until it is (and reaches it at once when it is).
let newSceneRequested = false;
const newSceneListeners = new Set<() => void>();

export function requestNewScene(): void {
  newSceneRequested = true;
  newSceneListeners.forEach((fn) => fn());
}

/** True once per request. */
export function takeNewSceneRequest(): boolean {
  const was = newSceneRequested;
  newSceneRequested = false;
  return was;
}

export function onNewSceneRequest(fn: () => void): () => void {
  newSceneListeners.add(fn);
  return () => {
    newSceneListeners.delete(fn);
  };
}
