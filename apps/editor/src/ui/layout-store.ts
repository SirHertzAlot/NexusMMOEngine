// Layout store for the DockShell – persists pane layout to localStorage.
// Simple key/value: {panes: Array<{id:string,visible:boolean,size:number}>}
// Uses the generic createStore helper.

import { createStore } from "./store.js";

type PaneLayout = {
  id: string;
  visible: boolean;
  size: number; // fractional (0‑1) or pixel size depending on pane type
};

type LayoutState = {
  panes: PaneLayout[];
};

const STORAGE_KEY = "editor-dock-layout";

function loadInitial(): LayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as LayoutState;
  } catch {
    // ignore parse errors
  }
  // default layout – empty for now
  return { panes: [] };
}

export const layoutStore = createStore<LayoutState>(loadInitial());

export const setLayout = (layout: LayoutState): void => {
  layoutStore.set(layout);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // ignore storage errors
  }
};

export const getLayout = layoutStore.get;
export const subscribeLayout = layoutStore.subscribe;
