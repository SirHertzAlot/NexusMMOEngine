/**
 * Active-document registry — what the toolbar's Save / Undo / Redo and the
 * File / Edit menus act on.
 *
 * Each document panel (scenes, flow, rules, graphs, dungeons, terrain,
 * story) registers its actions while it has an open document and clears
 * them when it unmounts or closes it. The toolbar and menus subscribe:
 * with no registration the buttons render disabled with a tooltip.
 *
 * The core (label, save, undo, redo) is required. The edit surface
 * (clipboard, selection, revert, import/export, save-all) is optional:
 * panels implement what their document model supports, and the menus
 * disable the rest with a reason instead of showing "soon" placeholders.
 *
 * Refused saves keep their contract: panel save() implementations throw
 * or return issues and write nothing (hosts validate first).
 */

/** One thing wrong with the open document, for the Problems tab and the status bar. */
export interface DocProblem {
  severity: "error" | "warn";
  /** Where in the document, e.g. a field path. */
  where: string;
  message: string;
}

export interface DocActions {
  /** Human label for tooltips, e.g. 'scene "arena-01"'. */
  label: string;
  canSave: boolean;
  canUndo: boolean;
  canRedo: boolean;
  save: () => void;
  undo: () => void;
  redo: () => void;
  /** What validation says about the document right now; absent when the panel does not validate. */
  problems?: DocProblem[];

  // --- Edit menu: clipboard & selection (optional per panel) ---
  /** Whether the panel has a clipboard-worthy selection right now. */
  canCut?: boolean;
  canCopy?: boolean;
  canPaste?: boolean;
  canDuplicate?: boolean;
  canDelete?: boolean;
  canSelectAll?: boolean;
  cut?: () => void;
  copy?: () => void;
  paste?: () => void;
  duplicate?: () => void;
  deleteSelection?: () => void;
  selectAll?: () => void;

  // --- File menu: document lifecycle (optional per panel) ---
  canSaveAll?: boolean;
  canRevert?: boolean;
  canImport?: boolean;
  canExport?: boolean;
  saveAll?: () => void;
  revert?: () => void;
  importFile?: () => void;
  exportFile?: () => void;
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
