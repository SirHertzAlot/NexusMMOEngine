/**
 * Unsaved changes the open panel reports for the Details pane. A panel sets
 * its list while it has edits and clears it when it unmounts.
 */

import type { PendingChange } from "../gameplay-diff.js";
import { createStore } from "../store.js";

export interface PendingReport {
  /** What the changes belong to, e.g. "creatures.json". */
  label: string;
  changes: readonly PendingChange[];
}

const store = createStore<PendingReport | null>(null);

export const setPendingChanges = store.set;
export const getPendingChanges = store.get;
export const subscribePendingChanges = store.subscribe;
export const usePendingChanges = store.use;
