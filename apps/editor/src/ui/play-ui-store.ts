/**
 * Shared play-mode UI state, on its own.
 *
 * It used to live in ui/play-mode.tsx beside the debug dock, which drags
 * the whole 3D client (`@mmo-engine/client/render`, `/debug`) in behind
 * it. Anything that only wants to KNOW the play state — the forge
 * context bar, and anything else that reads it later — imports this
 * instead and pays for a store, not a renderer. play-mode.tsx re-exports
 * it, so every existing importer is unchanged.
 */

import { createStore } from "../store.js";
import type { PlayModeState } from "../play-mode.js";

/** The debug dock drives the same entity-id and auto-refresh the overlays
 *  query, and mirrors the lifecycle state. */
export interface PlayUiState {
  entityId: string;
  autoRefresh: boolean;
  pmState: PlayModeState;
  paused: boolean;
}

export const playUiStore = createStore<PlayUiState>({
  entityId: "",
  autoRefresh: true,
  pmState: "idle",
  paused: false,
});

export function setPlayEntityId(entityId: string): void {
  playUiStore.set((p) => ({ ...p, entityId }));
}

export function setPlayAutoRefresh(autoRefresh: boolean): void {
  playUiStore.set((p) => ({ ...p, autoRefresh }));
}
