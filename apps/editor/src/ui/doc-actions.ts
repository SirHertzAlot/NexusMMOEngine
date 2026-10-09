/**
 * Document registry — what the menus, toolbar and Ctrl S / Ctrl Z act on.
 *
 * Each document panel (scenes, flow, rules, graphs, dungeons, terrain,
 * story, hud, strings, media) registers its actions while it has an open
 * document and clears them when it unmounts or closes it. Several panels
 * can be registered at once; the most recent is "active" (what Save, Undo,
 * Revert, Import and Export act on) and Save All saves every dirty one.
 * With no registration the buttons render disabled with a tooltip.
 *
 * Refused saves keep their contract: panel save() implementations throw
 * or return issues and write nothing (hosts validate first).
 */

/** Selection commands a document panel supports; a missing one is not available there. */
export interface DocEditCommands {
  copy?: () => void;
  cut?: () => void;
  paste?: () => void;
  duplicate?: () => void;
  remove?: () => void;
  selectAll?: () => void;
}

export interface DocActions {
  /** Human label for tooltips, e.g. 'scene "arena-01"'. */
  label: string;
  canSave: boolean;
  canUndo: boolean;
  canRedo: boolean;
  save: () => void | Promise<void>;
  undo: () => void;
  redo: () => void;
  /** Discard unsaved edits and reload the saved document. */
  revert?: () => void | Promise<void>;
  /** The document as JSON for File > Export (name is the download's base name). */
  exportDoc?: () => { name: string; data: unknown };
  /** Replace the draft with an imported document; throws a readable Error to refuse it. */
  importDoc?: (data: unknown) => void | Promise<void>;
  edit?: DocEditCommands;
}

let list: DocActions[] = [];
let current: DocActions | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  current = list.length > 0 ? list[list.length - 1] : null;
  listeners.forEach((fn) => fn());
}

/** The active document: the most recently registered. */
export function getDocActions(): DocActions | null {
  return current;
}

export function getAllDocActions(): readonly DocActions[] {
  return list;
}

export function registerDocActions(actions: DocActions): void {
  list = [...list.filter((a) => a !== actions), actions];
  emit();
}

export function clearDocActions(actions?: DocActions): void {
  if (actions === undefined) {
    if (list.length === 0) return;
    list = [];
  } else {
    if (!list.includes(actions)) return;
    list = list.filter((a) => a !== actions);
  }
  emit();
}

export function subscribeDocActions(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export interface SaveAllResult {
  saved: string[];
  failed: Array<{ label: string; error: string }>;
}

/** Save every dirty document, one after the other; a refused one is reported and does not stop the rest. */
export async function saveAllDocs(): Promise<SaveAllResult> {
  const out: SaveAllResult = { saved: [], failed: [] };
  for (const d of [...list]) {
    if (!d.canSave) continue;
    try {
      await d.save();
      out.saved.push(d.label);
    } catch (e) {
      out.failed.push({ label: d.label, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
