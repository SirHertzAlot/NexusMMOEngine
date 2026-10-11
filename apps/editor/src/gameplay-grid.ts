/**
 * The Gameplay data grids' model (roadmap EA15): rows of authored data, cell
 * parsing and validation, search, filter and sort, and the batch actions.
 *
 * Pure and browser-safe. The rows hold exactly what the file holds (so a save
 * writes back what was read); the server's own loaders have the last word on
 * a save (gameplay-host.ts), these checks only give the author the answer
 * while typing, per cell.
 */

import { fieldText, getAt, isFieldError, parseField, setAt, type FieldKind, type FieldSpec } from "./rules-control.js";

export type GridKind = FieldKind | { kind: "json" };

export type GridColumn = GridKind & {
  /** Dotted key inside the row's data ("drops.chance"). */
  key: string;
  label: string;
  def?: unknown;
  restart?: boolean;
  /** Shown in the expanded row instead of the grid. */
  nested?: boolean;
  /** Each value must be an id in `refs[ref]` (the table it names). */
  ref?: string;
  /** An enum whose options come from `options[optionsFrom]` in the context. */
  optionsFrom?: string;
  /** The cell holds asset ID(s); the grid offers a 3D preview. */
  assetKind?: "model" | "texture";
  /** A JSON column's own check: the problem with `value`, or null. */
  check?: (value: unknown, ctx: GridContext) => string | null;
};

export interface GridRow {
  id: string;
  data: Record<string, unknown>;
}

/** What the checks look things up in: id lists by table, option lists by name. */
export interface GridContext {
  refs: Record<string, readonly string[]>;
  options: Record<string, readonly string[]>;
}

export function parseCell(col: GridColumn, text: string): { value: unknown } | { error: string } {
  if (col.kind === "json") {
    if (text.trim() === "") return { value: undefined };
    try {
      return { value: JSON.parse(text) as unknown };
    } catch (e) {
      return { error: `not valid JSON: ${(e as Error).message}` };
    }
  }
  const v = parseField(col as FieldSpec, text);
  return isFieldError(v) ? v : { value: v };
}

/** A cell's text for its input. */
export function cellText(col: GridColumn, value: unknown): string {
  if (col.kind === "json") return value === undefined ? "" : JSON.stringify(value);
  return fieldText(col as FieldSpec, value);
}

/** The problem with `value` for `col`, or null (an absent value takes the engine default). */
export function checkCell(col: GridColumn, value: unknown, ctx: GridContext): string | null {
  if (value === undefined) return null;
  const range = (n: number, int: boolean | undefined, min?: number, max?: number): string | null => {
    if (typeof n !== "number" || !Number.isFinite(n)) return "must be a number";
    if (int && !Number.isInteger(n)) return "must be a whole number";
    if (min !== undefined && n < min) return `must be at least ${min}`;
    if (max !== undefined && n > max) return `must be at most ${max}`;
    return null;
  };
  switch (col.kind) {
    case "json":
      return col.check ? col.check(value, ctx) : null;
    case "number":
      return range(value as number, col.int, col.min, col.max);
    case "bool":
      return typeof value === "boolean" ? null : "must be true or false";
    case "enum": {
      const opts = col.optionsFrom ? ctx.options[col.optionsFrom] : col.options === "techniques" ? ctx.options.techniques : col.options;
      if (!opts || opts.length === 0) return null;
      return typeof value === "string" && opts.includes(value) ? null : `must be one of ${opts.join(", ")}`;
    }
    case "list": {
      if (!Array.isArray(value)) return "must be a list";
      const known = col.ref ? ctx.refs[col.ref] : undefined;
      const bad = known ? (value as string[]).find((v) => !known.includes(v)) : undefined;
      return bad === undefined ? null : `no ${col.ref} "${bad}"`;
    }
    case "pair": {
      if (!Array.isArray(value) || value.length !== 2) return "needs two whole numbers";
      const lo = (col as { min?: number }).min ?? 0;
      const bad = value.map((n) => range(n as number, true, lo)).find((m) => m !== null);
      if (bad) return bad;
      return (value[0] as number) > (value[1] as number) ? "min is above max" : null;
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ view

export interface GridView {
  search?: string;
  /** Column key -> text its cell must contain. */
  filters?: Record<string, string>;
  sort?: { key: string; dir: "asc" | "desc" };
}

const flat = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).toLowerCase();

/** The rows to show: searched, filtered and sorted. Never reorders `rows` itself. */
export function viewRows(rows: readonly GridRow[], view: GridView): GridRow[] {
  const q = (view.search ?? "").trim().toLowerCase();
  let out = rows.filter((r) => q === "" || r.id.toLowerCase().includes(q) || Object.values(r.data).some((v) => flat(v).includes(q)));
  for (const [key, needle] of Object.entries(view.filters ?? {})) {
    const n = needle.trim().toLowerCase();
    if (n !== "") out = out.filter((r) => flat(getAt(r.data, key)).includes(n));
  }
  if (view.sort) {
    const { key, dir } = view.sort;
    const sign = dir === "asc" ? 1 : -1;
    const val = (r: GridRow): unknown => (key === "id" ? r.id : getAt(r.data, key));
    out = [...out].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
      const c = typeof x === "number" && typeof y === "number" ? x - y : flat(x).localeCompare(flat(y));
      return sign * c;
    });
  }
  return out;
}

// ----------------------------------------------------------------- edits

const mapRows = (rows: readonly GridRow[], ids: readonly string[], f: (d: Record<string, unknown>) => Record<string, unknown>): GridRow[] =>
  rows.map((r) => (ids.includes(r.id) ? { id: r.id, data: f(r.data) } : r));

export const editCell = (rows: readonly GridRow[], id: string, key: string, value: unknown): GridRow[] => mapRows(rows, [id], (d) => setAt(d, key, value));

export const batchSet = (rows: readonly GridRow[], ids: readonly string[], key: string, value: unknown): GridRow[] => mapRows(rows, ids, (d) => setAt(d, key, value));

/** Multiply a number column in the chosen rows (whole-number columns round). */
export function batchScale(rows: readonly GridRow[], ids: readonly string[], col: GridColumn, factor: number): GridRow[] {
  return mapRows(rows, ids, (d) => {
    const v = getAt(d, col.key);
    if (typeof v !== "number") return d;
    const n = v * factor;
    return setAt(d, col.key, col.kind === "number" && col.int ? Math.round(n) : Math.round(n * 1e6) / 1e6);
  });
}

export const removeRows = (rows: readonly GridRow[], ids: readonly string[]): GridRow[] => rows.filter((r) => !ids.includes(r.id));

export function addRow(rows: readonly GridRow[], id: string, data: Record<string, unknown>): GridRow[] {
  if (rows.some((r) => r.id === id)) throw new Error(`"${id}" already exists`);
  return [...rows, { id, data }];
}

/** A copy of row `id` right after it, named `<id>-2` (or the next free number). */
export function duplicateRow(rows: readonly GridRow[], id: string): GridRow[] {
  const at = rows.findIndex((r) => r.id === id);
  if (at < 0) return [...rows];
  let n = 2;
  while (rows.some((r) => r.id === `${id}-${n}`)) n++;
  const copy: GridRow = { id: `${id}-${n}`, data: structuredClone(rows[at].data) };
  return [...rows.slice(0, at + 1), copy, ...rows.slice(at + 1)];
}
