/**
 * Database workspace model (roadmap EA16): pure helpers behind the data
 * grid — per-cell validation, search/sort, and pending edits turned into
 * the typed mutations the persistence core takes. No React, no fetch.
 */

export type SqlValue = string | number | null;

export interface Column {
  name: string;
  type: string;
  notNull: boolean;
  pk: number;
  editable: boolean;
}
export interface Table {
  name: string;
  rowCount: number;
  columns: Column[];
  editable: boolean;
  note?: string;
}
export interface Mutation {
  db: string;
  table: string;
  key: Record<string, SqlValue>;
  set: Record<string, SqlValue>;
}

/** Parse what the admin typed into a cell for its column; an error string when invalid. */
export function parseCell(col: Column, text: string): { value: SqlValue } | { error: string } {
  const t = col.type.toUpperCase();
  if (text.trim() === "" && (t.includes("INT") || /REAL|FLOA|DOUB|NUM/.test(t))) {
    return col.notNull ? { error: "may not be empty" } : { value: null };
  }
  if (t.includes("INT")) {
    const n = Number(text);
    return Number.isSafeInteger(n) ? { value: n } : { error: "must be a whole number" };
  }
  if (/REAL|FLOA|DOUB|NUM/.test(t)) {
    const n = Number(text);
    return Number.isFinite(n) ? { value: n } : { error: "must be a number" };
  }
  return { value: text };
}

export type Row = unknown[];

/** Rows containing `search` in any cell (case-insensitive), sorted by one column. */
export function viewRows(
  rows: Row[],
  columns: string[],
  search: string,
  sort: { column: string; dir: "asc" | "desc" } | null,
): Row[] {
  const q = search.trim().toLowerCase();
  let out = q ? rows.filter((r) => r.some((c) => String(c ?? "").toLowerCase().includes(q))) : rows;
  const i = sort ? columns.indexOf(sort.column) : -1;
  if (sort && i >= 0) {
    const s = sort.dir === "asc" ? 1 : -1;
    out = [...out].sort((a, b) => {
      const x = a[i];
      const y = b[i];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * s;
    });
  }
  return out;
}

/** A staged cell edit, addressed by the row's primary-key values. */
export interface Pending {
  key: Record<string, SqlValue>;
  column: string;
  value: SqlValue;
}

export const rowKey = (table: Table, columns: string[], row: Row): Record<string, SqlValue> =>
  Object.fromEntries(table.columns.filter((c) => c.pk > 0).map((c) => [c.name, row[columns.indexOf(c.name)] as SqlValue]));

/** Group staged edits into one mutation per row. */
export function toMutations(db: string, table: string, pending: Pending[]): Mutation[] {
  const byRow = new Map<string, Mutation>();
  for (const p of pending) {
    const id = JSON.stringify(p.key);
    const m = byRow.get(id) ?? { db, table, key: p.key, set: {} };
    m.set[p.column] = p.value;
    byRow.set(id, m);
  }
  return [...byRow.values()];
}

/** Stage an edit, replacing an earlier one for the same cell; dropping it when it restores the original. */
export function stage(pending: Pending[], next: Pending, original: unknown): Pending[] {
  const same = (p: Pending): boolean => p.column === next.column && JSON.stringify(p.key) === JSON.stringify(next.key);
  const rest = pending.filter((p) => !same(p));
  return next.value === original ? rest : [...rest, next];
}
