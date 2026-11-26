/**
 * The placeables, fetched once for the whole editor (roadmap EB4).
 *
 * The palette and the viewport both need the list — the palette to show it,
 * the viewport to know which ids are creatures — and the editor's rule is
 * one hook per data source, so this is that hook rather than a second
 * fetch in each component. The request is made once per page and shared;
 * `reloadPlaceables()` drops it (the tests use it, and so would a "content
 * changed" event when there is one).
 */

import * as React from "react";
import { fetchPlaceables, type Placeables } from "../scene-content-client.js";
import { createStore } from "../store.js";

export interface PlaceablesState {
  content: Placeables | null;
  error: string | null;
}

const store = createStore<PlaceablesState>({ content: null, error: null });
let started = false;

/** Start the one request, if it has not been made yet. */
export function loadPlaceables(): void {
  if (started) return;
  started = true;
  fetchPlaceables().then(
    (content) => store.set({ content, error: null }),
    (e: Error) => store.set({ content: null, error: e.message }),
  );
}

/** Forget what was loaded, so the next reader fetches again. */
export function reloadPlaceables(): void {
  started = false;
  store.set({ content: null, error: null });
}

export const getPlaceables = store.get;
export const setPlaceables = store.set;
export const subscribePlaceables = store.subscribe;

/** The list as React state, fetching it the first time anything asks. */
export function usePlaceables(): PlaceablesState {
  const state = store.useValue();
  React.useEffect(() => loadPlaceables(), []);
  return state;
}
