/**
 * Rows of the File and Edit menus and the viewport options, as data: each
 * row runs a real command or is disabled with the reason (shown as its
 * tooltip). Pure, so the rules are testable without a DOM; the shell
 * passes the commands in (shell-actions.ts).
 */

import type { DocActions, DocEditCommands } from "./doc-actions.js";
import { flagBlocked, viewportBlocked, type ViewportAdapter, type ViewportFlags } from "./viewport-bus.js";

export interface MenuRow {
  label: string;
  kbd?: string;
  run?: () => void;
  /** Why the command cannot run now; the row is shown disabled with this as its tooltip. */
  disabled?: string;
  checked?: boolean;
}
export type MenuRows = Array<MenuRow | "sep">;

export interface ShellCommands {
  newScene(): void;
  openScene(): void;
  save(): void;
  saveAll(): void;
  revert(): void;
  importDoc(): void;
  exportDoc(): void;
  undo(): void;
  redo(): void;
  edit(cmd: keyof DocEditCommands): void;
}

const NO_DOC = "no document is open in this workspace";

export const whySave = (d: DocActions | null): string | undefined => (!d ? NO_DOC : d.canSave ? undefined : "no unsaved changes");
export const whyRevert = (d: DocActions | null): string | undefined =>
  !d ? NO_DOC : !d.revert ? "this document does not support Revert" : d.canSave ? undefined : "no unsaved changes";
export const whyUndo = (d: DocActions | null): string | undefined => (!d ? NO_DOC : d.canUndo ? undefined : "nothing to undo");
export const whyRedo = (d: DocActions | null): string | undefined => (!d ? NO_DOC : d.canRedo ? undefined : "nothing to redo");
export const whyExport = (d: DocActions | null): string | undefined => (!d ? NO_DOC : d.exportDoc ? undefined : "this document has no JSON form to export");
export const whyImport = (d: DocActions | null): string | undefined =>
  !d ? NO_DOC : d.importDoc && d.exportDoc ? undefined : "this document cannot take an imported file";

const EDIT_REASON: Record<keyof DocEditCommands, string> = {
  copy: "select a node first (the Scenes outliner or viewport)",
  cut: "select a node first (the Scenes outliner or viewport)",
  paste: "copy a node first",
  duplicate: "select a node first (the Scenes outliner or viewport)",
  remove: "select a node first (the Scenes outliner or viewport)",
  selectAll: "the selection is one item at a time here",
};

/** Why an Edit-menu command cannot run, or undefined. Only the Scenes panel offers selection commands today. */
export function whyEdit(d: DocActions | null, cmd: keyof DocEditCommands): string | undefined {
  if (!d) return NO_DOC;
  if (d.edit?.[cmd]) return undefined;
  return d.edit === undefined ? `${d.label} has no selection commands` : EDIT_REASON[cmd];
}

export function fileRows(doc: DocActions | null, anyDirty: boolean, run: ShellCommands): MenuRows {
  return [
    { label: "New Scene", run: run.newScene },
    { label: "Open Scene…", run: run.openScene },
    "sep",
    { label: "Save", kbd: "Ctrl S", run: run.save, disabled: whySave(doc) },
    { label: "Save All", run: run.saveAll, disabled: anyDirty ? undefined : "no unsaved changes" },
    { label: "Revert", run: run.revert, disabled: whyRevert(doc) },
    "sep",
    { label: "Import…", run: run.importDoc, disabled: whyImport(doc) },
    { label: "Export…", run: run.exportDoc, disabled: whyExport(doc) },
  ];
}

export function editRows(doc: DocActions | null, run: ShellCommands): MenuRows {
  const e = (label: string, cmd: keyof DocEditCommands): MenuRow => ({ label, run: () => run.edit(cmd), disabled: whyEdit(doc, cmd) });
  return [
    { label: "Undo", kbd: "Ctrl Z", run: run.undo, disabled: whyUndo(doc) },
    { label: "Redo", kbd: "Ctrl Shift Z", run: run.redo, disabled: whyRedo(doc) },
    "sep",
    e("Cut", "cut"),
    e("Copy", "copy"),
    e("Paste", "paste"),
    e("Duplicate", "duplicate"),
    e("Delete", "remove"),
    "sep",
    e("Select All", "selectAll"),
  ];
}

export function zoomRows(
  run: { zoomIn(): void; zoomOut(): void; reset(): void },
): MenuRows {
  return [
    { label: "Zoom In", run: run.zoomIn, disabled: viewportBlocked("zoom-in") ?? undefined },
    { label: "Zoom Out", run: run.zoomOut, disabled: viewportBlocked("zoom-out") ?? undefined },
    { label: "Reset Viewport", run: run.reset, disabled: viewportBlocked("reset") ?? undefined },
  ];
}

export function viewportOptionRows(
  vp: ViewportAdapter | null,
  flags: ViewportFlags,
  run: { toggle(k: keyof ViewportFlags): void; screenshot(): void },
): MenuRows {
  const toggle = (label: string, key: keyof ViewportFlags): MenuRow => ({
    label,
    checked: flags[key],
    run: () => run.toggle(key),
    disabled: flagBlocked(key) ?? undefined,
  });
  return [
    toggle("Grid", "grid"),
    toggle("Gizmos", "gizmos"),
    toggle("Wireframe", "wireframe"),
    "sep",
    { label: "Screenshot viewport", run: run.screenshot, disabled: vp ? undefined : "no 3D viewport is open (open Scenes or play the game)" },
  ];
}
