/**
 * The Database workspace's selected table, shared by the left schema tree
 * and the Data grid so picking a table in either opens it in the grid.
 */

export interface DbSelection {
  db: string;
  table: string;
}

let current: DbSelection | null = null;
const listeners = new Set<() => void>();

export function getDbSelection(): DbSelection | null {
  return current;
}

export function setDbSelection(sel: DbSelection | null): void {
  if (sel?.db === current?.db && sel?.table === current?.table) return;
  current = sel;
  listeners.forEach((fn) => fn());
}

export function subscribeDbSelection(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
