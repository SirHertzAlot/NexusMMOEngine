/**
 * The HUD editor's document state (roadmap EA23): the layout being edited,
 * what is saved, and an undo/redo history. Pure; hud-editor.tsx holds one in
 * a store and every panel (catalog, preview, inspector) reads the same one.
 */
import { moveHudWidget, reanchorHudWidget, type HudAnchor, type HudDoc, type HudProblems, type HudWidget } from "@mmo-engine/scene";

export interface HudModel {
  doc: HudDoc;
  /** The document as last loaded or saved (JSON), to tell what changed. */
  saved: string;
  past: HudDoc[];
  future: HudDoc[];
}

export const hudModel = (doc: HudDoc): HudModel => ({ doc, saved: JSON.stringify(doc), past: [], future: [] });
export const hudDirty = (m: HudModel): boolean => JSON.stringify(m.doc) !== m.saved;

/** Apply an edit as one undo step. An edit that changes nothing is not a step. */
export function hudEdit(m: HudModel, next: HudDoc): HudModel {
  if (JSON.stringify(next) === JSON.stringify(m.doc)) return m;
  return { ...m, doc: next, past: [...m.past, m.doc].slice(-100), future: [] };
}

export function hudUndo(m: HudModel): HudModel {
  const prev = m.past[m.past.length - 1];
  return prev ? { ...m, doc: prev, past: m.past.slice(0, -1), future: [m.doc, ...m.future] } : m;
}
export function hudRedo(m: HudModel): HudModel {
  const next = m.future[0];
  return next ? { ...m, doc: next, past: [...m.past, m.doc], future: m.future.slice(1) } : m;
}
export const hudMarkSaved = (m: HudModel): HudModel => ({ ...m, saved: JSON.stringify(m.doc) });
/** Back to the saved document (itself an undo step). */
export const hudRevert = (m: HudModel): HudModel => hudEdit(m, JSON.parse(m.saved) as HudDoc);

const withWidget = (doc: HudDoc, id: string, w: HudWidget): HudDoc => ({ ...doc, widgets: { ...doc.widgets, [id]: w } });

export function hudPatchWidget(m: HudModel, id: string, patch: Partial<HudWidget>): HudModel {
  const cur = m.doc.widgets[id];
  return cur ? hudEdit(m, withWidget(m.doc, id, { ...cur, ...patch })) : m;
}

/** A drag: the widget as it was when the pointer went down, moved by the pointer's travel in viewport px. */
export function hudDragWidget(m: HudModel, start: HudDoc, id: string, dxPx: number, dyPx: number, scale: number): HudModel {
  const from = start.widgets[id];
  if (!from) return m;
  return { ...m, doc: withWidget(m.doc, id, moveHudWidget(from, dxPx, dyPx, scale)) };
}
/** Pointer down on a widget: remember the document so the whole drag becomes one undo step. */
export const hudDragStart = (m: HudModel): HudDoc => m.doc;
export function hudDragEnd(m: HudModel, start: HudDoc): HudModel {
  if (JSON.stringify(m.doc) === JSON.stringify(start)) return m;
  return { ...m, past: [...m.past, start].slice(-100), future: [] };
}

export function hudReanchor(m: HudModel, id: string, anchor: HudAnchor, vp: { w: number; h: number }, scale: number): HudModel {
  const cur = m.doc.widgets[id];
  return cur ? hudEdit(m, withWidget(m.doc, id, reanchorHudWidget(cur, anchor, vp, scale))) : m;
}

export function hudSetTheme(m: HudModel, token: string, value: string): HudModel {
  return hudEdit(m, { ...m.doc, theme: { ...m.doc.theme, [token]: value } });
}

/** Problems that involve one widget at this size, for the inspector. */
export function widgetProblems(p: HudProblems, id: string): { overlaps: string[]; offscreen: boolean } {
  return { overlaps: p.overlaps.filter((o) => o.includes(id)).map((o) => (o[0] === id ? o[1] : o[0])), offscreen: p.offscreen.includes(id) };
}

