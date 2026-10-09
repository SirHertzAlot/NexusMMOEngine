/**
 * Unsaved changes the open panel reports for the Details pane. A panel sets
 * its list while it has edits and clears it when it unmounts.
 */

import * as React from "react";
import type { PendingChange } from "../gameplay-diff.js";

export interface PendingReport {
  /** What the changes belong to, e.g. "creatures.json". */
  label: string;
  changes: readonly PendingChange[];
}

let current: PendingReport | null = null;
const listeners = new Set<() => void>();

export function setPendingChanges(report: PendingReport | null): void {
  current = report;
  listeners.forEach((fn) => fn());
}

export function getPendingChanges(): PendingReport | null {
  return current;
}

export function subscribePendingChanges(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function usePendingChanges(): PendingReport | null {
  return React.useSyncExternalStore(subscribePendingChanges, getPendingChanges);
}
