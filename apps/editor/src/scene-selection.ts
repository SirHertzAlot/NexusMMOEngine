/**
 * Selecting more than one scene node (roadmap EB2).
 *
 * The editor's shared selection (`ui/editor-selection.ts`) is one object,
 * because that is what the Details pane shows. Building a scene needs a
 * set: move five rocks together, align a row of torches, delete a camp.
 * This is that set, kept pure so the click rules — plain click replaces,
 * ctrl or cmd toggles, shift extends over what the outliner shows — can be
 * tested without a DOM.
 *
 * `primary` is the node the gizmo rides and the Details pane shows: the
 * last one added, not the first, which is what every editor does and what
 * makes "ctrl-click one more, then drag" behave.
 */

export interface SceneSelection {
  /** Selected node ids, in the order they were added. */
  ids: readonly string[];
  /** The node the gizmo and Details follow; null when nothing is selected. */
  primary: string | null;
}

export const NO_SELECTION: SceneSelection = { ids: [], primary: null };

/** Just this node (a plain click), or nothing. */
export function selectOnly(id: string | null): SceneSelection {
  return id === null ? NO_SELECTION : { ids: [id], primary: id };
}

export function isSelected(sel: SceneSelection, id: string): boolean {
  return sel.ids.includes(id);
}

/** The set as a lookup, for the viewport's per-node redraw. */
export function selectedSet(sel: SceneSelection): ReadonlySet<string> {
  return new Set(sel.ids);
}

/**
 * Ctrl or cmd click: add the node, or drop it if it was already in. Dropping
 * the primary hands primary to whatever is still selected (the last of it),
 * so the gizmo never vanishes while a selection remains.
 */
export function toggleSelected(sel: SceneSelection, id: string): SceneSelection {
  if (!isSelected(sel, id)) return { ids: [...sel.ids, id], primary: id };
  const ids = sel.ids.filter((x) => x !== id);
  return { ids, primary: sel.primary === id ? (ids[ids.length - 1] ?? null) : sel.primary };
}

/**
 * Shift click: everything between the primary and `id` in `order` — the
 * rows as the outliner lists them, so the range is what the eye sees, not
 * what the tree nests. With no primary it behaves like a plain click.
 */
export function extendSelection(sel: SceneSelection, order: readonly string[], id: string): SceneSelection {
  const to = order.indexOf(id);
  const from = sel.primary === null ? -1 : order.indexOf(sel.primary);
  if (to === -1 || from === -1) return selectOnly(id);
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const span = order.slice(lo, hi + 1);
  // Keep what was selected outside the range (ctrl-built sets survive a
  // shift-click), with the range appended in its visible order.
  const kept = sel.ids.filter((x) => !span.includes(x));
  return { ids: [...kept, ...span], primary: id };
}

/** What a click means, given the modifier keys. */
export function clickSelection(
  sel: SceneSelection,
  order: readonly string[],
  id: string,
  mods: { additive?: boolean; range?: boolean },
): SceneSelection {
  if (mods.range) return extendSelection(sel, order, id);
  if (mods.additive) return toggleSelected(sel, id);
  return selectOnly(id);
}

/** Drop ids that are no longer in the document (after a delete or a reload). */
export function pruneSelection(sel: SceneSelection, exists: (id: string) => boolean): SceneSelection {
  const ids = sel.ids.filter(exists);
  if (ids.length === sel.ids.length) return sel;
  return { ids, primary: sel.primary && ids.includes(sel.primary) ? sel.primary : (ids[ids.length - 1] ?? null) };
}

/** "3 nodes selected", for the toolbar. */
export function selectionLabel(sel: SceneSelection): string {
  if (sel.ids.length === 0) return "Nothing selected";
  if (sel.ids.length === 1) return "1 node selected";
  return `${sel.ids.length} nodes selected`;
}
