/**
 * Database workspace (roadmap EA16): schema tree + data grid with pending
 * edits, a read-only Query tab, and the Audit log with undo. Talks to the
 * dev host's PersistenceCore routes. Edits apply in maintenance mode only
 * (game server stopped); the grid says so when the host refuses.
 */
import * as React from "react";
import { applyMutations, fetchCatalog, fetchLog, runQuery, undoEntry, type Db, type LogEntry, type QueryResult } from "../database-client.js";
import { parseCell, rowKey, stage, toMutations, viewRows, type Pending, type Table } from "../database-model.js";
import { Badge, Button, Input, MIcon, notify, Select } from "./components.js";
import { getDbSelection, setDbSelection, subscribeDbSelection } from "./db-selection.js";

const cell = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const th = "sticky top-0 bg-muted px-2 py-1 text-left text-xs font-medium whitespace-nowrap";
const td = "px-2 py-1 text-xs font-mono whitespace-nowrap max-w-[24rem] overflow-hidden text-ellipsis";
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function useCatalog(): { dbs: Db[]; error: string; reload: () => void } {
  const [dbs, setDbs] = React.useState<Db[]>([]);
  const [error, setError] = React.useState("");
  const reload = React.useCallback(() => {
    fetchCatalog().then((d) => (setDbs(d), setError(""))).catch((e) => setError(msg(e)));
  }, []);
  React.useEffect(reload, [reload]);
  return { dbs, error, reload };
}

function ResultTable({ columns, rows }: { columns: string[]; rows: unknown[][] }): React.JSX.Element {
  return (
    <table className="w-full border-collapse">
      <thead><tr>{columns.map((c) => <th key={c} className={th}>{c}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-border">{r.map((v, j) => <td key={j} className={td}>{cell(v)}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------ Data grid

export function DatabaseGridPanel(): React.JSX.Element {
  const { dbs, error, reload } = useCatalog();
  const [sel, setSel] = React.useState<{ db: string; table: string } | null>(null);
  const [data, setData] = React.useState<QueryResult | null>(null);
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState<{ column: string; dir: "asc" | "desc" } | null>(null);
  const [pending, setPending] = React.useState<Pending[]>([]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [status, setStatus] = React.useState("");

  const table: Table | undefined = dbs.find((d) => d.name === sel?.db)?.tables.find((t) => t.name === sel?.table);

  const load = React.useCallback((s: { db: string; table: string }) => {
    setPending([]);
    setErrors({});
    runQuery(s.db, `SELECT * FROM "${s.table.replace(/"/g, '""')}"`, 500).then(setData).catch((e) => setStatus(msg(e)));
  }, []);
  const pick = (db: string, t: string): void => {
    setSel({ db, table: t });
    setSearch("");
    setSort(null);
    setStatus("");
    load({ db, table: t });
    setDbSelection({ db, table: t });
  };
  // The left schema tree picks tables too; follow it (and open its pick on mount).
  const shared = React.useSyncExternalStore(subscribeDbSelection, getDbSelection);
  React.useEffect(() => {
    if (shared && (shared.db !== sel?.db || shared.table !== sel?.table)) pick(shared.db, shared.table);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared]);

  const editCell = (row: unknown[], column: string, text: string): void => {
    if (!table || !data) return;
    const col = table.columns.find((c) => c.name === column)!;
    const key = `${JSON.stringify(rowKey(table, data.columns, row))}:${column}`;
    const parsed = parseCell(col, text);
    if ("error" in parsed) return setErrors((e) => ({ ...e, [key]: parsed.error }));
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== key)));
    setPending((p) => stage(p, { key: rowKey(table, data.columns, row), column, value: parsed.value }, row[data.columns.indexOf(column)]));
  };

  const apply = async (): Promise<void> => {
    if (!sel) return;
    try {
      const done = await applyMutations(toMutations(sel.db, sel.table, pending));
      notify(`${done.length} row${done.length === 1 ? "" : "s"} changed — logged in the audit log`);
      load(sel);
      reload();
    } catch (e) {
      setStatus(msg(e));
    }
  };

  const rows = data ? viewRows(data.rows, data.columns, search, sort) : [];
  const pendingFor = (row: unknown[], column: string): Pending | undefined =>
    table && data ? pending.find((p) => p.column === column && JSON.stringify(p.key) === JSON.stringify(rowKey(table, data.columns, row))) : undefined;

  return (
    <div className="flex h-full min-h-0">
      <nav className="w-56 shrink-0 overflow-auto border-r border-border p-2 text-sm" aria-label="Schema">
        {error && <p className="text-destructive text-xs">{error}</p>}
        {dbs.map((d) => (
          <details key={d.name} open>
            <summary className="cursor-pointer py-1 font-medium"><MIcon name="database" size={16} /> {d.file}</summary>
            {d.tables.map((t) => (
              <button
                key={t.name}
                onClick={() => pick(d.name, t.name)}
                className={`flex w-full items-center justify-between rounded px-3 py-1 text-left text-xs hover:bg-muted ${sel?.table === t.name && sel.db === d.name ? "bg-muted" : ""}`}
              >
                <span>{t.name}</span><span className="text-muted-foreground">{t.rowCount}</span>
              </button>
            ))}
          </details>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        {!table || !data ? (
          <p className="p-4 text-sm text-muted-foreground">{status || "Pick a table in the schema tree."}</p>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border p-2">
              <Input className="h-8 max-w-xs" placeholder="Search rows" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search rows" />
              <span className="text-xs text-muted-foreground">
                {rows.length} of {table.rowCount} rows{data.truncated ? " (first 500 loaded)" : ""}
              </span>
              {!table.editable && <Badge>read-only: {table.note}</Badge>}
              <span className="flex-1" />
              {pending.length > 0 && (
                <>
                  <span className="text-xs">{pending.length} change{pending.length === 1 ? "" : "s"}</span>
                  <Button size="sm" variant="outline" onClick={() => (setPending([]), setErrors({}))}>Discard</Button>
                  <Button size="sm" onClick={() => void apply()}>Apply</Button>
                </>
              )}
            </div>
            {status && <p className="border-b border-border px-3 py-1 text-xs text-destructive" role="alert">{status}</p>}
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    {data.columns.map((c) => (
                      <th key={c} className={`${th} cursor-pointer`} onClick={() => setSort(sort?.column === c && sort.dir === "asc" ? { column: c, dir: "desc" } : { column: c, dir: "asc" })} aria-sort={sort?.column === c ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                        {c}{sort?.column === c ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-b border-border">
                      {r.map((v, j) => {
                        const name = data.columns[j];
                        const col = table.columns.find((c) => c.name === name);
                        const p = pendingFor(r, name);
                        const errKey = `${JSON.stringify(rowKey(table, data.columns, r))}:${name}`;
                        const editable = table.editable && col?.editable;
                        return (
                          <td key={j} className={`${td} ${p ? "bg-primary/10" : ""}`} title={errors[errKey]}>
                            {editable ? (
                              <input
                                className={`w-full bg-transparent outline-none focus:ring-1 focus:ring-ring ${errors[errKey] ? "ring-1 ring-destructive" : ""}`}
                                aria-label={`${name} row ${i + 1}`}
                                aria-invalid={Boolean(errors[errKey])}
                                defaultValue={cell(p ? p.value : v)}
                                onBlur={(e) => e.target.value !== cell(p ? p.value : v) && editCell(r, name, e.target.value)}
                              />
                            ) : (
                              cell(v)
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Query

export function DatabaseQueryPanel(): React.JSX.Element {
  const { dbs } = useCatalog();
  const [db, setDb] = React.useState("");
  const [sql, setSql] = React.useState("SELECT name FROM sqlite_master WHERE type = 'table'");
  const [result, setResult] = React.useState<QueryResult | null>(null);
  const [error, setError] = React.useState("");
  const target = db || dbs[0]?.name || "";

  const run = (): void => {
    setError("");
    runQuery(target, sql, 500).then(setResult).catch((e) => (setResult(null), setError(msg(e))));
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <Select size="sm" value={target} onChange={(e) => setDb(e.target.value)} aria-label="Database">
          {dbs.map((d) => <option key={d.name} value={d.name}>{d.file}</option>)}
        </Select>
        <Button size="sm" onClick={run} disabled={!target}>Run (read-only)</Button>
        <span className="text-xs text-muted-foreground">SELECT only · 500 rows · 2 s limit</span>
      </div>
      <textarea
        className="h-32 w-full rounded border border-input bg-background p-2 font-mono text-xs"
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        aria-label="SQL"
        spellCheck={false}
      />
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      {result && (
        <div className="min-h-0 flex-1 overflow-auto">
          <p className="text-xs text-muted-foreground">{result.rows.length} rows{result.truncated ? " (more rows were cut off by the limit)" : ""}</p>
          <ResultTable columns={result.columns} rows={result.rows} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ Audit log

export function DatabaseAuditPanel(): React.JSX.Element {
  const [log, setLog] = React.useState<LogEntry[]>([]);
  const [status, setStatus] = React.useState("");
  const reload = React.useCallback(() => {
    fetchLog().then(setLog).catch((e) => setStatus(msg(e)));
  }, []);
  React.useEffect(reload, [reload]);

  const undo = async (id: number): Promise<void> => {
    try {
      await undoEntry(id);
      setStatus("");
      reload();
    } catch (e) {
      setStatus(msg(e));
    }
  };
  return (
    <div className="h-full overflow-auto p-3">
      <div className="mb-2 flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={reload}>Refresh</Button>
        {status && <span className="text-xs text-destructive" role="alert">{status}</span>}
      </div>
      <table className="w-full border-collapse">
        <thead><tr>{["#", "When", "Admin", "Op", "Where", "Row", "Before", "After", ""].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
        <tbody>
          {log.map((e) => (
            <tr key={e.id} className="border-b border-border">
              <td className={td}>{e.id}</td>
              <td className={td}>{new Date(e.ts).toLocaleString()}</td>
              <td className={td}>{e.admin}</td>
              <td className={td}>{e.op}</td>
              <td className={td}>{e.db}.{e.table}</td>
              <td className={td}>{JSON.stringify(e.key)}</td>
              <td className={td}>{JSON.stringify(e.before)}</td>
              <td className={td}>{JSON.stringify(e.after)}</td>
              <td className={td}>
                {e.op === "update" && (e.undoneBy === null
                  ? <Button size="sm" variant="outline" onClick={() => void undo(e.id)}>Undo</Button>
                  : <span className="text-muted-foreground">undone by #{e.undoneBy}</span>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {log.length === 0 && <p className="p-3 text-sm text-muted-foreground">No edits yet.</p>}
    </div>
  );
}
