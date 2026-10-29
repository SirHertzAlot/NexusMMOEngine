/**
 * One table for every grid, log and key/value list in the editor.
 *
 * Callers describe the columns (header, how to draw a cell) and hand over
 * the rows; the sticky header, sortable-header buttons and `aria-sort`,
 * row selection highlight, hover row menu, expandable detail row and the
 * M3 density live here. Changing the table once changes them all.
 *
 * A column's cell is a click-through by default (a click anywhere on the
 * row picks it); a column with `interactive` holds inputs or buttons, so
 * its clicks stay inside it.
 */

import * as React from "react";
import { OverflowMenu, type MenuItem } from "./components.js";

export interface SortState {
  id: string;
  dir: "asc" | "desc";
}

/** Header click: asc, then desc, then (when `clearable`) back to unsorted. */
export function nextSort(sort: SortState | null, id: string, clearable = false): SortState | null {
  if (sort?.id !== id) return { id, dir: "asc" };
  if (sort.dir === "asc") return { id, dir: "desc" };
  return clearable ? null : { id, dir: "asc" };
}

export interface Column<R> {
  id: string;
  header?: React.ReactNode;
  cell: (row: R, index: number) => React.ReactNode;
  mono?: boolean;
  nowrap?: boolean;
  align?: "left" | "right";
  width?: string;
  /** Header becomes a sort button (needs `sort` and `onSort` on the table). */
  sortable?: boolean;
  /** The cell holds controls: clicks on it do not pick the row. */
  interactive?: boolean;
  cellTitle?: (row: R) => string | undefined;
  cellClass?: (row: R) => string | undefined;
}

export interface DataTableProps<R> {
  columns: ReadonlyArray<Column<R>>;
  rows: readonly R[];
  rowKey: (row: R, index: number) => string;
  /** Key of the picked row, or a predicate for multi-select. */
  selected?: string | null | ((row: R) => boolean);
  onPick?: (row: R) => void;
  rowTitle?: (row: R) => string | undefined;
  /** Hover ⋯ menu per row. */
  menu?: (row: R, index: number) => Array<MenuItem | "sep">;
  /** Accessible name of the row menu button (default: "<row key> actions"). */
  menuLabel?: (row: R) => string;
  /** Hover controls per row, when a menu is not enough. */
  rowActions?: (row: R, index: number) => React.ReactNode;
  sort?: SortState | null;
  onSort?: (id: string) => void;
  /** Extra full-width row under a row (return null for none). */
  detail?: (row: R) => React.ReactNode;
  /** Plain `<tbody>` with no header row (key/value lists). */
  headless?: boolean;
  mono?: boolean;
  /** Taller rows (42px instead of 30px). */
  comfortable?: boolean;
  emptyText?: string;
  ariaLabel?: string;
  testId?: string;
  className?: string;
}

const PICKED = "#2b2f4a";
const HEAD_BG = "var(--m3-surface-2)";

export function DataTable<R>(props: DataTableProps<R>): React.JSX.Element {
  const { columns, rows, rowKey, selected, onPick, rowTitle, menu, rowActions, sort, onSort, detail, headless = false, mono = false, comfortable = false } = props;
  const hasActions = Boolean(menu || rowActions);
  const isPicked = (row: R, key: string): boolean =>
    typeof selected === "function" ? selected(row) : selected !== undefined && selected !== null && selected === key;
  const rowH = comfortable ? 42 : 30;
  const span = columns.length + (hasActions ? 1 : 0);

  return (
    <>
      <table className={props.className ?? "w-full border-collapse text-[12.5px]"} aria-label={props.ariaLabel} data-testid={props.testId}>
        {!headless && (
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.id === c.id;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    aria-sort={c.sortable ? (active ? (sort.dir === "asc" ? "ascending" : "descending") : "none") : undefined}
                    className={`sticky top-0 whitespace-nowrap px-2 font-medium ${c.align === "right" ? "text-right" : "text-left"}`}
                    style={{ background: HEAD_BG, color: "var(--m3-on-surface-variant)", height: 32, width: c.width }}
                  >
                    {c.sortable && onSort ? (
                      <button className="m3-focus font-medium" onClick={() => onSort(c.id)}>
                        {c.header}
                        {active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
              {hasActions && (
                <th className="sticky top-0 w-10" style={{ background: HEAD_BG, height: 32 }}>
                  <span className="sr-only">Row actions</span>
                </th>
              )}
            </tr>
          </thead>
        )}
        <tbody className={mono ? "font-mono text-xs" : undefined} style={{ containIntrinsicSize: "0 500px", contentVisibility: "auto" }}>
          {rows.map((row, i) => {
            const key = rowKey(row, i);
            const on = isPicked(row, key);
            const more = detail?.(row);
            return (
              <React.Fragment key={key}>
                <tr
                  onClick={onPick ? () => onPick(row) : undefined}
                  className={`group ${onPick ? "cursor-pointer" : ""}`}
                  title={rowTitle?.(row)}
                  aria-selected={onPick ? on : undefined}
                  style={{ borderBottom: "1px solid #2a2b31", background: on ? PICKED : undefined }}
                >
                  {columns.map((c) => (
                    <td
                      key={c.id}
                      title={c.cellTitle?.(row)}
                      className={`px-2 ${c.nowrap ? "whitespace-nowrap" : ""} ${c.mono ? "font-mono" : ""} ${c.align === "right" ? "text-right" : ""} ${c.cellClass?.(row) ?? ""}`}
                      style={{ height: rowH }}
                      onClick={c.interactive ? (e) => e.stopPropagation() : undefined}
                    >
                      {c.cell(row, i)}
                    </td>
                  ))}
                  {hasActions && (
                    <td className="px-1" style={{ height: rowH }} onClick={(e) => e.stopPropagation()}>
                      <span className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        {rowActions?.(row, i)}
                        {menu && <OverflowMenu label={props.menuLabel?.(row) ?? `${key} actions`} items={menu(row, i)} />}
                      </span>
                    </td>
                  )}
                </tr>
                {more != null && more !== false && (
                  <tr style={{ background: "var(--m3-surface-1)" }}>
                    <td colSpan={span} className="px-2 py-2">{more}</td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && props.emptyText && (
        <p className="px-3 py-2 text-sm" style={{ color: "var(--m3-on-surface-variant)" }}>{props.emptyText}</p>
      )}
    </>
  );
}

/** Key / value list: a headless two-column table. */
export function KvTable({ rows }: { rows: Array<{ key: string; value: string }> }): React.JSX.Element {
  return (
    <DataTable
      headless
      className="w-full text-xs"
      rows={rows}
      rowKey={(r) => r.key}
      columns={[
        { id: "key", mono: true, cell: (r) => <span style={{ color: "var(--m3-on-surface-variant)" }}>{r.key}</span> },
        { id: "value", mono: true, align: "right", cellClass: () => "break-all", cell: (r) => r.value },
      ]}
    />
  );
}
