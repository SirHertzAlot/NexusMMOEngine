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

import * as React from "react";
import { createSlot } from "../store.js";

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

const slot = createSlot<DocActions>();

export const getDocActions = slot.get;
export const subscribeDocActions = slot.subscribe;
export const registerDocActions = (actions: DocActions): void => slot.set(actions);

/** Release `actions` (or, with none given, whatever is registered). */
export function clearDocActions(actions?: DocActions): void {
  if (actions !== undefined && slot.get() !== actions) return;
  slot.set(null);
}

/**
 * Register what the open document can do for as long as the panel shows it.
 * `build` runs every render (so it reads current state) and returns null
 * while nothing is open; the registration moves with the latest object.
 */
export function useDocActions(build: () => DocActions | null): void {
  React.useEffect(() => {
    const target = build();
    if (!target) return;
    registerDocActions(target);
    return () => clearDocActions(target);
  });
}

/** For panels whose edits apply directly: Undo and Redo stay disabled. */
export const NO_HISTORY = { canUndo: false, canRedo: false, undo: () => undefined, redo: () => undefined } as const;

