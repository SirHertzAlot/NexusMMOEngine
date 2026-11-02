/**
 * Shared viewport tool store — the toolbar's single source of truth.
 *
 * The toolbar used to keep `tool` in local useState, so no viewport
 * could see it. Every viewport now reads this store instead:
 *
 * - terrain sculpt: only while the move tool is active (otherwise the
 *   left button orbits like everywhere else);
 * - dungeon: prop drag only with move, otherwise orbit + pick;
 * - graph / flow canvases: node drag only with move, otherwise pan +
 *   select;
 * - game view: no separate orbit mode (the follow camera owns it), so
 *   select stays the camera/pick default there.
 *
 * Tools are the toolbar's existing ids: select | move | rotate | scale.
 * ("snap" stays a toolbar-local toggle, not a viewport mode: viewports
 * treat any unknown tool like select.)
 */


import { createStore } from "../store.js";

export type EditorTool = string;

const store = createStore<EditorTool>("select");

export const getTool = store.get;
export const setTool = store.set;
export const subscribeTool = store.subscribe;
export const useTool = store.useValue;
