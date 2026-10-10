/**
 * The saved play setups as a shared store: the Play menu edits them, the
 * keyboard handler and the command palette read them, and every change
 * is written back to storage.
 */

import { createStore } from "../store.js";
import { bindSetupShortcut, loadSavedSetups, persistSavedSetups, removeSavedSetup, upsertSavedSetup, type PlaySetup, type SavedPlaySetup } from "./play-setup.js";

export const savedSetupsStore = createStore<SavedPlaySetup[]>(loadSavedSetups());

function commit(next: SavedPlaySetup[]): void {
  savedSetupsStore.set(next);
  persistSavedSetups(next);
}

export function saveSetupAs(name: string, setup: PlaySetup): void {
  commit(upsertSavedSetup(savedSetupsStore.get(), name, setup));
}

export function deleteSetup(name: string): void {
  commit(removeSavedSetup(savedSetupsStore.get(), name));
}

/** Bind a key; returns why it was refused, or null. */
export function bindSetupKey(name: string, key: string | null): string | null {
  const r = bindSetupShortcut(savedSetupsStore.get(), name, key);
  if (r.error === null) commit(r.all);
  return r.error;
}
