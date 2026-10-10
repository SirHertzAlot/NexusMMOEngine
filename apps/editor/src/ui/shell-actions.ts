/**
 * What the shell's File menu, viewport options and dock menus do beyond the
 * panels' own registered commands (doc-actions.ts, viewport-actions.ts): each
 * reports its outcome in the snackbar. Why a command is unavailable is the
 * menus' job; these only run what is available.
 */

import { notify } from "./components.js";
import { getDocActions, type DocActions } from "./doc-actions.js";
import { downloadBlob, exportDocument, importDocument } from "./doc-io.js";
import { getViewportActions } from "./viewport-actions.js";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The open document has unsaved edits. */
export const anyUnsaved = (): boolean => getDocActions()?.canSave === true;

export function canExport(d: DocActions | null): boolean {
  return !!d && (!!d.exportDoc || (d.canExport === true && !!d.exportFile));
}

export function canImport(d: DocActions | null): boolean {
  return !!d && ((!!d.importDoc && !!d.exportDoc) || (d.canImport === true && !!d.importFile));
}

export function exportActive(): void {
  const d = getDocActions();
  if (!d) return;
  if (!d.exportDoc) {
    d.exportFile?.();
    return;
  }
  try {
    notify(`Exported ${d.label} as ${exportDocument(d)}`);
  } catch (e) {
    notify(`Export: ${msg(e)}`);
  }
}

export async function importActive(): Promise<void> {
  const d = getDocActions();
  if (!d) return;
  if (!d.importDoc) {
    d.importFile?.();
    return;
  }
  try {
    const file = await importDocument(d);
    if (file !== null) notify(`Imported ${file} into ${d.label} — review it, then Save`);
  } catch (e) {
    notify(`Import refused, nothing changed: ${msg(e)}`);
  }
}

/** Revert, asking first when it would throw away unsaved edits. */
export async function revertActive(): Promise<void> {
  const d = getDocActions();
  if (!d?.revert) return;
  if (d.canSave && !window.confirm(`Discard the unsaved changes to ${d.label} and reload the saved copy?`)) return;
  try {
    await d.revert();
    notify(`Reverted ${d.label}`);
  } catch (e) {
    notify(`Revert ${d.label}: ${msg(e)}`);
  }
}

/** Open the current view's deep link (workspace, view, selection) in a new browser window. */
export function popOutPanel(): void {
  const w = window.open(window.location.href, "_blank", "popup=yes,width=1280,height=800");
  if (!w) notify("The browser blocked the new window - allow pop-ups for this page");
}

/** Download a PNG of the active 3D viewport. */
export async function screenshotViewport(): Promise<void> {
  const v = getViewportActions();
  if (!v?.screenshot) {
    notify("Screenshot: no 3D viewport is open (open Scenes or play the game)");
    return;
  }
  try {
    const blob = await v.screenshot();
    if (!blob) {
      notify("Screenshot: the viewport had nothing to capture");
      return;
    }
    const name = `${v.label.replace(/\s+/g, "-")}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    downloadBlob(name, blob);
    notify(`Saved ${name}`);
  } catch (e) {
    notify(`Screenshot: ${msg(e)}`);
  }
}
