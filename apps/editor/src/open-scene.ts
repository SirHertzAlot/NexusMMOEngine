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
