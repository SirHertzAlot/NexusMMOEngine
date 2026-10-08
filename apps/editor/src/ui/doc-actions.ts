/**
 * Active-document registry — what the toolbar's Save / Undo / Redo act on.
 *
 * Each document panel (scenes, flow, rules, graphs, dungeons, terrain,
 * story) registers its actions while it has an open document and clears
 * them when it unmounts or closes it. The toolbar subscribes: with no
 * registration the buttons render disabled with a tooltip.
 *
 * Refused saves keep their contract: panel save() implementations throw
 * or return issues and write nothing (hosts validate first).
 */

export interface DocActions {
  /** Human label for tooltips, e.g. 'scene "arena-01"'. */
  label: string;
  canSave: boolean;
  canUndo: boolean;
  canRedo: boolean;
  save: () => void;
  undo: () => void;
  redo: () => void;
}

let current: DocActions | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((fn) => fn());
}

export function getDocActions(): DocActions | null {
  return current;
}

export function registerDocActions(actions: DocActions): void {
  current = actions;
  emit();
}

export function clearDocActions(actions?: DocActions): void {
  if (actions !== undefined && current !== actions) return;
  if (current === null) return;
  current = null;
  emit();
}

export function subscribeDocActions(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
