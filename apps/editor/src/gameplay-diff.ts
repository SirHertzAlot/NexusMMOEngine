/**
 * What a gameplay grid has changed against what is saved, as the short rows
 * the Details pane lists ("goblin.health  55 → 60").
 */

import { cellText, checkCell, type GridColumn, type GridContext, type GridRow } from "./gameplay-grid.js";
import { getAt } from "./rules-control.js";

export interface PendingChange {
  kind: "edit" | "add" | "remove" | "error";
  /** Row id and, for an edit or a problem, the column: `goblin.health`. */
  path: string;
  /** "55 → 60", "new row", "removed" or the problem text. */
  change: string;
}

const show = (col: GridColumn, v: unknown): string => {
  const t = cellText(col, v);
  return t === "" ? "(default)" : t.length > 24 ? `${t.slice(0, 23)}…` : t;
};

/**
 * Edits, added rows, removed rows and the cells the checks reject, in row
 * order (saved rows first, then added ones). Only edited cells and added
 * rows are checked: a problem already in the saved file is not an unsaved
 * change, and listing it would keep the pane from ever reading "nothing
 * changed".
 */
export function diffRows(saved: readonly GridRow[], current: readonly GridRow[], cols: readonly GridColumn[], ctx: GridContext): PendingChange[] {
  const out: PendingChange[] = [];
  const before = new Map(saved.map((r) => [r.id, r]));
  const now = new Map(current.map((r) => [r.id, r]));
  for (const r of saved) {
    const c = now.get(r.id);
    if (!c) {
      out.push({ kind: "remove", path: r.id, change: "removed" });
      continue;
    }
    for (const col of cols) {
      const a = getAt(r.data, col.key);
      const b = getAt(c.data, col.key);
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ kind: "edit", path: `${r.id}.${col.key}`, change: `${show(col, a)} → ${show(col, b)}` });
    }
  }
  for (const c of current) if (!before.has(c.id)) out.push({ kind: "add", path: c.id, change: "new row" });
  for (const c of current) {
    const was = before.get(c.id);
    for (const col of cols) {
      const v = getAt(c.data, col.key);
      if (was && JSON.stringify(getAt(was.data, col.key)) === JSON.stringify(v)) continue;
      const problem = checkCell(col, v, ctx);
      if (problem) out.push({ kind: "error", path: `${c.id}.${col.key}`, change: problem });
    }
  }
  return out;
}
