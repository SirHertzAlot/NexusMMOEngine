/**
 * Gameplay data grids and the content browser (roadmap EA15).
 *
 * The grids edit the files the server loads (creatures, item bases, skills,
 * spells, species): search, per-column filter, sort, inline edit with a check
 * per cell, expandable rows for the nested data (a creature's drops and
 * weapons), batch actions on the selected rows. "Check" and "Save" go to the
 * dev host, which validates with the server's own loaders; a refused save
 * writes nothing and its issues mark the cells they are about.
 */

import * as React from "react";
import { DocBar } from "./doc-bar.js";
import { useSaveTask } from "./use-save-task.js";
import { useTableDrafts } from "./use-table-drafts.js";
import { issueCount } from "../save-outcome.js";
import {
  addRow,
  batchScale,
  batchSet,
  cellText,
  checkCell,
  duplicateRow,
  editCell,
  parseCell,
  removeRows,
  viewRows,
  type GridColumn,
  type GridContext,
  type GridRow,
} from "../gameplay-grid.js";
import { GAMEPLAY_TABLES, TABLE_DEFS, cellOfIssue, fromRows, toRows, type GameplayTable, type TableDef } from "../gameplay-tables.js";
import { checkGameplayRemote, loadCatalog, loadGameplay, saveGameplayRemote, type GameplayIssue, type GameplaySnapshot } from "../gameplay-client.js";
import { CATALOG_KINDS, type CatalogEntry, type CatalogKind } from "../content-catalog-types.js";
import { getAt } from "../rules-control.js";
import { diffRows } from "../gameplay-diff.js";
import { setPendingChanges } from "./pending-changes.js";
import { DataTable, nextSort, type Column, type SortState } from "./data-table.js";
import { Badge, Button, Card, CardContent, Input, Select, Field } from "./components.js";

export const CONTENT_MIME = "application/x-mmo-content";

type Rows = Record<GameplayTable, GridRow[]>;

const rowsOf = (snap: GameplaySnapshot): Rows =>
  Object.fromEntries(GAMEPLAY_TABLES.map((t) => [t, toRows(TABLE_DEFS[t], snap.tables[t])])) as Rows;

// ------------------------------------------------------------------- cell

import { AssetPreview } from "./asset-preview.js";

function Cell(props: { col: GridColumn; value: unknown; error: string | null; ctx: GridContext; onCommit: (v: unknown) => void }): React.JSX.Element {
  const { col, value, error, ctx, onCommit } = props;
  const [text, setText] = React.useState(cellText(col, value));
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [showPreview, setShowPreview] = React.useState(false);
  React.useEffect(() => {
    setText(cellText(col, value));
    setParseError(null);
  }, [col, value]);
  const shown = parseError ?? error;
  const cls = "h-7 w-full rounded border bg-background px-1.5 font-mono text-xs " + (shown ? "border-red-500" : "border-input");
  const label = `${col.label}${shown ? `: ${shown}` : ""}`;

  // Asset columns get a preview toggle beside the editor.
  const previewButton = col.assetKind && typeof value === "string" && value !== "" ? (
    <button
      type="button"
      aria-label={`Preview ${value}`}
      title={`Preview ${value}`}
      className="ml-1 rounded border border-input px-1.5 text-xs"
      onClick={() => setShowPreview((s) => !s)}
    >
      {showPreview ? "▾" : "👁"}
    </button>
  ) : null;
  const preview = col.assetKind && showPreview && typeof value === "string" && value !== "" ? (
    <div className="mt-1">
      <AssetPreview assetId={value} label={value} />
    </div>
  ) : null;

  if (col.kind === "bool") {
    return <input type="checkbox" aria-label={label} title={label} checked={value === true || (value === undefined && col.def === true)} onChange={(e) => onCommit(e.target.checked)} />;
  }
  if (col.kind === "enum") {
    const opts = col.optionsFrom ? ctx.options[col.optionsFrom] : typeof col.options === "string" ? ctx.options[col.options] : col.options;
    return (
      <Select size="xs" invalid={!!shown} className="w-full font-mono" aria-label={label} title={label} value={typeof value === "string" ? value : ""} onChange={(e) => onCommit(e.target.value === "" ? undefined : e.target.value)}>
        <option value="">{col.def !== undefined ? `(${String(col.def)})` : ""}</option>
        {(opts ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    );
  }
  const commit = (): void => {
    if (text === cellText(col, value)) return;
    const r = parseCell(col, text);
    if ("error" in r) return setParseError(r.error);
    setParseError(null);
    onCommit(r.value);
  };
  return (
    <div>
      <div className="flex items-center">
        <input
          aria-label={label}
          title={label}
          aria-invalid={shown ? true : undefined}
          className={cls}
          placeholder={col.def !== undefined ? cellText(col, col.def) : ""}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setText(cellText(col, value));
          }}
        />
        {previewButton}
      </div>
      {preview}
    </div>
  );
}

// ------------------------------------------------------------------- grid

export function GameplayGridsPanel(): React.JSX.Element {
  const [snap, setSnap] = React.useState<GameplaySnapshot | null>(null);
  const grids = useTableDrafts<GameplayTable, GridRow[]>();
  const { drafts: rows, saved: savedRows, load: loadRows } = grids;
  const [table, setTable] = React.useState<GameplayTable>("creatures");
  const [search, setSearch] = React.useState("");
  const [filterKey, setFilterKey] = React.useState("");
  const [filterText, setFilterText] = React.useState("");
  const [sort, setSort] = React.useState<SortState | null>(null);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());
  const [dense, setDense] = React.useState(true);
  const task = useSaveTask<GameplayIssue>();
  const { issues, status, busy, setIssues, setStatus } = task;
  const [newId, setNewId] = React.useState("");
  const [batchKey, setBatchKey] = React.useState("");
  const [batchText, setBatchText] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      const s = await loadGameplay();
      setSnap(s);
      loadRows(rowsOf(s));
      setIssues([]);
      setStatus(null);
      setSelected(new Set());
    } catch (e) {
      setStatus({ tone: "bad", text: (e as Error).message });
    }
  }, [loadRows]);
  React.useEffect(() => void load(), [load]);

  // The Details pane lists what this grid has changed against what is saved (every table, not only the shown one).
  React.useEffect(() => {
    if (!snap || !rows || !savedRows) return;
    const refs = { items: rows.items.map((r) => r.id), creatures: rows.creatures.map((r) => r.id) };
    const ctx: GridContext = { refs, options: snap.context.options };
    const saved = savedRows;
    const changes = GAMEPLAY_TABLES.flatMap((t) =>
      diffRows(saved[t], rows[t], TABLE_DEFS[t].columns, ctx).map((c) => ({ ...c, path: `${t}.${c.path}` })),
    );
    setPendingChanges(changes.length > 0 ? { label: "Gameplay tables", changes } : null);
  }, [snap, rows, savedRows]);
  React.useEffect(() => () => setPendingChanges(null), []);
  // Deferred values are hooks: they must run before the early return below, or the hook count changes between renders.
  const deferredSearch = React.useDeferredValue(search);
  const deferredFilterKey = React.useDeferredValue(filterKey);
  const deferredFilterText = React.useDeferredValue(filterText);

  if (!snap || !rows || !savedRows) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">{status ? status.text : "Loading the game's data…"}</CardContent>
      </Card>
    );
  }

  const def: TableDef = TABLE_DEFS[table];
  const mine = rows[table];
  const dirty = grids.dirtyOf;
  const ctx: GridContext = {
    refs: { ...snap.context.refs, items: rows.items.map((r) => r.id), creatures: rows.creatures.map((r) => r.id), prefabs: rows.prefabs.map((r) => r.id) },
    options: { ...snap.context.options, lootTables: rows.loot.map((r) => r.id) },
  };
  const setMine = (next: GridRow[]): void => {
    grids.edit(table, next);
    setStatus(null);
  };
  const shownRows = viewRows(mine, { search: deferredSearch, filters: deferredFilterKey ? { [deferredFilterKey]: deferredFilterText } : {}, sort: sort ? { key: sort.id, dir: sort.dir } : undefined });
  const mainCols = def.columns.filter((c) => !c.nested);
  const nestedCols = def.columns.filter((c) => c.nested);
  const serverCell = (rowId: string, key: string): string | null =>
    issues.filter((i) => { const c = cellOfIssue(def, i.path, mine); return c?.rowId === rowId && c.key === key; }).map((i) => i.message)[0] ?? null;
  const unplaced = issues.filter((i) => cellOfIssue(def, i.path, mine) === null || !mine.some((r) => r.id === cellOfIssue(def, i.path, mine)?.rowId));
  const errorOf = (r: GridRow, c: GridColumn): string | null => checkCell(c, getAt(r.data, c.key), ctx) ?? serverCell(r.id, c.key);
  const localErrors = mine.reduce((n, r) => n + def.columns.filter((c) => checkCell(c, getAt(r.data, c.key), ctx) !== null).length, 0);
  const ids = [...selected].filter((id) => mine.some((r) => r.id === id));
  const numeric = def.columns.filter((c) => c.kind === "number");
  const idError = newId === "" ? null : !def.idPattern.test(newId) ? "not a valid id" : mine.some((r) => r.id === newId) ? "taken" : null;

  const content = (): unknown => fromRows(def, snap.tables[table], mine);
  const run = async (what: "check" | "save"): Promise<void> => {
    if (what === "check") {
      await task.run(async () => {
        const found = await checkGameplayRemote(table, content());
        setIssues(found);
        return found;
      }, {
        keepIssues: true,
        ok: (found) => (found.length === 0 ? "The server's loader accepts this." : { tone: "bad", text: `${issueCount(found.length)} marked.` }),
      });
      return;
    }
    await task.run(async () => {
      await saveGameplayRemote(table, content());
      await load();
    }, {
      ok: `Saved ${def.file}. A running server picks it up on its next tick (restart for the few boot-time fields).`,
      refused: (found) => `Not saved: ${issueCount(found.length)}; nothing was written.`,
    });
  };
  const toggle = (set: ReadonlySet<string>, id: string): Set<string> => {
    const n = new Set(set);
    if (!n.delete(id)) n.add(id);
    return n;
  };
  const batch = (kind: "set" | "scale"): void => {
    const col = def.columns.find((c) => c.key === batchKey);
    if (!col || ids.length === 0) return;
    if (kind === "scale") {
      const f = Number(batchText);
      if (!Number.isFinite(f)) return setStatus({ tone: "bad", text: "Scale needs a number, e.g. 1.5." });
      return setMine(batchScale(mine, ids, col, f));
    }
    const r = parseCell(col, batchText);
    if ("error" in r) return setStatus({ tone: "bad", text: r.error });
    setMine(batchSet(mine, ids, col.key, r.value));
  };
  const add = (): void => {
    if (newId === "" || idError) return;
    setMine(addRow(mine, newId, def.newData(ctx)));
    setOpen(new Set(open).add(newId));
    setNewId("");
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Gameplay tables">
        {GAMEPLAY_TABLES.map((t) => (
          <Button key={t} role="tab" aria-selected={t === table} size="sm" variant={t === table ? "default" : "outline"} onClick={() => { setTable(t); setSelected(new Set()); setIssues([]); setSort(null); React.startTransition(() => setFilterKey("")); }}>
            {TABLE_DEFS[t].label}
            {dirty(t) && <span aria-label="unsaved" className="h-2 w-2 rounded-full bg-yellow-400" />}
          </Button>
        ))}
        <span className="ml-auto font-mono text-xs text-muted-foreground">{def.file}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 w-48" placeholder={`Search ${def.label.toLowerCase()}…`} aria-label="Search" value={search} onChange={(e) => React.startTransition(() => setSearch(e.target.value))} />
        <Select size="xs" aria-label="Filter column" value={filterKey} onChange={(e) => React.startTransition(() => setFilterKey(e.target.value))}>
          <option value="">filter by…</option>
          {def.columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </Select>
        {filterKey && <Input className="h-8 w-32" aria-label="Filter text" placeholder="contains" value={filterText} onChange={(e) => React.startTransition(() => setFilterText(e.target.value))} />}
        <Button size="sm" variant="ghost" onClick={() => setDense(!dense)}>{dense ? "Comfortable rows" : "Compact rows"}</Button>
        <span className="text-xs text-muted-foreground">{shownRows.length} of {mine.length} rows{localErrors > 0 ? `, ${localErrors} cell problem${localErrors === 1 ? "" : "s"}` : ""}</span>
        <div className="ml-auto flex items-center gap-2">
          {status && <Badge tone={status.tone}>{status.text}</Badge>}
          <DocBar
            dirty={dirty(table)}
            busy={busy}
            onSave={() => void run("save")}
            onRevert={() => { grids.revert(table); setIssues([]); setStatus(null); }}
          >
            <Button size="sm" variant="outline" onClick={() => void run("check")} disabled={busy}>Check</Button>
          </DocBar>
        </div>
      </div>

      {ids.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-input bg-accent/40 px-2 py-1 text-xs" role="toolbar" aria-label="Batch actions">
          <span>{ids.length} selected</span>
          <Select size="sm" aria-label="Batch column" value={batchKey} onChange={(e) => setBatchKey(e.target.value)}>
            <option value="">column…</option>
            {def.columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </Select>
          <Input className="h-7 w-28" aria-label="Batch value" placeholder="value" value={batchText} onChange={(e) => setBatchText(e.target.value)} />
          <Button size="sm" variant="outline" className="h-7" onClick={() => batch("set")} disabled={!batchKey}>Set</Button>
          <Button size="sm" variant="outline" className="h-7" onClick={() => batch("scale")} disabled={!numeric.some((c) => c.key === batchKey)}>Multiply by</Button>
          <Button size="sm" variant="outline" className="h-7" onClick={() => ids.forEach((id) => setMine(duplicateRow(mine, id)))} disabled={ids.length !== 1}>Duplicate</Button>
          <Button size="sm" variant="outline" className="h-7" onClick={() => { setMine(removeRows(mine, ids)); setSelected(new Set()); }}>Delete</Button>
        </div>
      )}

      <div className="overflow-auto rounded-md border border-input">
        <DataTable
          className="w-full border-collapse text-left text-xs"
          rows={shownRows}
          rowKey={(r) => r.id}
          selected={(r) => selected.has(r.id)}
          sort={sort}
          onSort={(id) => setSort(nextSort(sort, id, true))}
          comfortable={!dense}
          detail={(r) =>
            open.has(r.id) && nestedCols.length > 0 && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-x-4 gap-y-2">
                {nestedCols.map((c) => (
                  <Field key={c.key} label={`${c.label}${c.ref ? ` (${c.ref})` : ""}`} error={errorOf(r, c)}>
                    <Cell col={c} value={getAt(r.data, c.key)} error={errorOf(r, c)} ctx={ctx} onCommit={(v) => setMine(editCell(mine, r.id, c.key, v))} />
                  </Field>
                ))}
              </div>
            )
          }
          columns={[
            {
              id: "select",
              width: "2rem",
              interactive: true,
              header: (
                <input type="checkbox" aria-label="Select all shown rows" checked={shownRows.length > 0 && shownRows.every((r) => selected.has(r.id))} onChange={(e) => setSelected(e.target.checked ? new Set(shownRows.map((r) => r.id)) : new Set())} />
              ),
              cell: (r) => <input type="checkbox" aria-label={`Select ${r.id}`} checked={selected.has(r.id)} onChange={() => setSelected(toggle(selected, r.id))} />,
            },
            {
              id: "id",
              header: "id",
              sortable: true,
              mono: true,
              interactive: true,
              cell: (r) => (
                <>
                  {nestedCols.length > 0 && (
                    <button aria-label={open.has(r.id) ? `Collapse ${r.id}` : `Expand ${r.id}`} aria-expanded={open.has(r.id)} className="mr-1" onClick={() => setOpen(toggle(open, r.id))}>
                      {open.has(r.id) ? "▾" : "▸"}
                    </button>
                  )}
                  {r.id}
                  {def.columns.some((c) => errorOf(r, c)) && <span aria-label="has problems" className="ml-1 inline-block h-2 w-2 rounded-full bg-red-500" />}
                </>
              ),
            },
            ...mainCols.map((c): Column<(typeof shownRows)[number]> => ({
              id: c.key,
              header: c.label,
              sortable: true,
              interactive: true,
              cell: (r) => <Cell col={c} value={getAt(r.data, c.key)} error={errorOf(r, c)} ctx={ctx} onCommit={(v) => setMine(editCell(mine, r.id, c.key, v))} />,
            })),
          ]}
        />
      </div>

      <div className="flex items-center gap-2">
        <Input className="h-8 w-48 font-mono" placeholder={`new ${def.noun} id`} aria-label="New row id" value={newId} onChange={(e) => setNewId(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <Button size="sm" variant="outline" onClick={add} disabled={newId === "" || idError !== null}>Add {def.noun}</Button>
        {idError && <span className="text-xs text-red-400">{idError}</span>}
      </div>

      {unplaced.length > 0 && (
        <ul className="rounded-md border border-red-500/50 p-2 text-xs" aria-label="Issues">
          {unplaced.map((i, n) => (
            <li key={n}>
              <span className="font-mono">{i.file}{i.path ? `: ${i.path}` : ""}</span> {i.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// -------------------------------------------------------- content browser

const KIND_LABEL: Record<CatalogKind, string> = {
  species: "Species",
  creature: "Creatures",
  item: "Item bases",
  prefab: "Prefabs",
  picg: "PICG assets",
  scene: "Scenes",
  quest: "Quests",
};

/** What a drag carries: the catalog entry's payload plus the scene node it becomes (null: not placeable yet). */
export function dragPayload(e: CatalogEntry): string {
  return JSON.stringify({ ...e.drag, node: e.node });
}

/** Lists everything the game defines; drag an entry onto the scene viewport (MIME `application/x-mmo-content`). */
export function ContentBrowserPanel(): React.JSX.Element {
  const [data, setData] = React.useState<{ entries: CatalogEntry[]; notes: string[] } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [kind, setKind] = React.useState<CatalogKind | "all">("all");
  const [q, setQ] = React.useState("");
  React.useEffect(() => {
    loadCatalog().then(setData, (e: Error) => setError(e.message));
  }, []);
  if (!data) return <Card><CardContent className="p-4 text-sm text-muted-foreground">{error ?? "Loading the content catalog…"}</CardContent></Card>;
  const needle = q.trim().toLowerCase();
  const list = data.entries.filter((e) => (kind === "all" || e.kind === kind) && (needle === "" || `${e.id} ${e.label}`.toLowerCase().includes(needle)));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 w-48" aria-label="Search content" placeholder="Search content…" value={q} onChange={(e) => React.startTransition(() => setQ(e.target.value))} />
        {(["all", ...CATALOG_KINDS] as const).map((k) => (
          <Button key={k} size="sm" variant={kind === k ? "default" : "outline"} onClick={() => setKind(k)}>
            {k === "all" ? "All" : KIND_LABEL[k]}
          </Button>
        ))}
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2" style={{ containIntrinsicSize: "0 500px", contentVisibility: "auto" }}>
        {list.map((e) => (
          <li
            key={`${e.kind}:${e.id}`}
            draggable={e.node !== null}
            onDragStart={(ev) => {
              ev.dataTransfer.setData(CONTENT_MIME, dragPayload(e));
              ev.dataTransfer.effectAllowed = "copy";
            }}
            title={e.node ? "Drag onto the scene viewport" : "Not placeable in a scene yet"}
            className={"rounded-md border border-input px-2 py-1 text-xs " + (e.node ? "cursor-grab" : "opacity-80")}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono">{e.id}</span>
              <Badge>{e.kind}</Badge>
            </div>
            <div className="text-muted-foreground">{e.label} · {e.detail}</div>
          </li>
        ))}
      </ul>
      {data.notes.map((n) => <p key={n} className="text-[11px] text-muted-foreground">{n}</p>)}
    </div>
  );
}
