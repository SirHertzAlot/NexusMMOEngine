/**
 * What the shell's menus and toolbar do, in one place: each runs against the
 * active document (doc-actions.ts) or the active viewport (viewport-bus.ts)
 * and reports the outcome in the snackbar. (Why a command is unavailable is
 * menu-model.ts's job; these only run what is available.)
 */

import { notify } from "./components.js";
import { getAllDocActions, getDocActions, saveAllDocs, type DocEditCommands } from "./doc-actions.js";
import { downloadBlob, exportDocument, importDocument } from "./doc-io.js";
import { getViewport } from "./viewport-bus.js";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const anyUnsaved = (): boolean => getAllDocActions().some((d) => d.canSave);

async function guarded(label: string, fn: () => void | Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    notify(`${label}: ${msg(e)}`);
    return false;
  }
}

/** Labels of the documents that are still dirty once their panels have re-rendered after a save (a refused save leaves them dirty). */
async function stillDirty(labels: string[]): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 200));
  return labels.filter((l) => getAllDocActions().some((d) => d.label === l && d.canSave));
}

export async function saveActive(): Promise<void> {
  const d = getDocActions();
  if (!d || !d.canSave) return;
  if (!(await guarded(`Save ${d.label}`, d.save))) return;
  notify((await stillDirty([d.label])).length === 0 ? `Saved ${d.label}` : `${d.label} was not saved - see its problems list; nothing was written`);
}

export async function saveEverything(): Promise<void> {
  const r = await saveAllDocs();
  const refused = await stillDirty(r.saved);
  const saved = r.saved.filter((l) => !refused.includes(l));
  const failed = [...r.failed.map((f) => `${f.label} (${f.error})`), ...refused.map((l) => `${l} (see its problems list)`)];
  if (saved.length === 0 && failed.length === 0) notify("Nothing to save");
  else if (failed.length === 0) notify(`Saved ${saved.join(", ")}`);
  else notify(`Saved ${saved.length}; refused, nothing written: ${failed.join("; ")}`);
}

export function undoActive(): void {
  const d = getDocActions();
  if (d?.canUndo) d.undo();
}

export function redoActive(): void {
  const d = getDocActions();
  if (d?.canRedo) d.redo();
}

export function editActive(cmd: keyof DocEditCommands): void {
  getDocActions()?.edit?.[cmd]?.();
}

export async function revertActive(): Promise<void> {
  const d = getDocActions();
  if (!d?.revert) return;
  if (d.canSave && !window.confirm(`Discard the unsaved changes to ${d.label} and reload the saved copy?`)) return;
  if (await guarded(`Revert ${d.label}`, d.revert)) notify(`Reverted ${d.label}`);
}

export function exportActive(): void {
  const d = getDocActions();
  if (!d) return;
  try {
    notify(`Exported ${d.label} as ${exportDocument(d)}`);
  } catch (e) {
    notify(`Export: ${msg(e)}`);
  }
}

export async function importActive(): Promise<void> {
  const d = getDocActions();
  if (!d) return;
  try {
    const file = await importDocument(d);
    if (file !== null) notify(`Imported ${file} into ${d.label} — review it, then Save`);
  } catch (e) {
    notify(`Import refused, nothing changed: ${msg(e)}`);
  }
}

/** Open the current panel's deep link (workspace, view, selection) in a new browser window. */
export function popOutPanel(): void {
  const w = window.open(window.location.href, "_blank", "popup=yes,width=1280,height=800");
  if (!w) notify("The browser blocked the new window - allow pop-ups for this page");
}

/** Download a PNG of the active 3D viewport. */
export async function screenshotViewport(): Promise<void> {
  const v = getViewport();
  if (!v) {
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
