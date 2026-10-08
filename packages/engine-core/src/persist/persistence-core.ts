/**
 * PersistenceCore — the editor's door to the game databases (roadmap EA16).
 *
 *  - catalog(): every table in every *.db of the data dir, with columns and row counts.
 *  - query():  SELECT only, on a read-only connection in a child process,
 *              with a row limit and a timeout (the process is killed).
 *  - apply()/undo(): typed mutations (db, table, primary key, new values),
 *              validated against the table's schema and recorded with their
 *              before-image in `admin_log` (admin.db, never a game file).
 *
 * LIVE STATE IS NOT HANDLED HERE. A running server holds in-memory copies of
 * its rows and is the only writer; writing behind it would be overwritten.
 * Mutations therefore run in maintenance mode only: apply() refuses while a
 * server looks alive (`isServerRunning`), and
 * takes a backup copy of each touched database first. Routing a mutation
 * through the stores between ticks is deferred (docs/EDITOR-ARCHITECTURE.md §7b.1).
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";

export type SqlValue = string | number | null;

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  /** 1-based position in the primary key, 0 when not part of it. */
  pk: number;
  editable: boolean;
}
export interface TableInfo {
  name: string;
  rowCount: number;
  columns: ColumnInfo[];
  /** False for append-only / keyless tables. */
  editable: boolean;
  /** Why the table cannot be edited, when it cannot. */
  note?: string;
}
export interface DbInfo {
  name: string;
  file: string;
  bytes: number;
  tables: TableInfo[];
}
export interface Mutation {
  db: string;
  table: string;
  key: Record<string, SqlValue>;
  set: Record<string, SqlValue>;
}
export interface AdminLogEntry {
  id: number;
  ts: number;
  admin: string;
  op: "update" | "undo";
  db: string;
  table: string;
  key: Record<string, SqlValue>;
  before: Record<string, SqlValue>;
  after: Record<string, SqlValue>;
  /** The entry this one reverses (op "undo"). */
  undoes: number | null;
  /** Set on an update once an undo of it was applied. */
  undoneBy: number | null;
}
export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

export class PersistenceError extends Error {
  constructor(readonly code: "bad-request" | "refused" | "timeout" | "conflict", message: string) {
    super(message);
    this.name = "PersistenceError";
  }
}

/** Append-only by design (item ledger, snapshots, events): never edited. */
const APPEND_ONLY = new Set(["world.item_events", "world.snapshots", "world.events"]);
export const QUERY_MAX_ROWS = 5000;
export const QUERY_DEFAULT_ROWS = 500;
export const QUERY_DEFAULT_TIMEOUT_MS = 2000;

const quote = (id: string): string => `"${id.replace(/"/g, '""')}"`;

/** Value check against a column's declared type; returns a problem or null. */
export function checkValue(col: ColumnInfo, v: SqlValue): string | null {
  if (v === null) return col.notNull ? "may not be empty" : null;
  const t = col.type.toUpperCase();
  if (t.includes("INT")) return Number.isSafeInteger(v) ? null : "must be a whole number";
  if (/REAL|FLOA|DOUB|NUM/.test(t)) return typeof v === "number" && Number.isFinite(v) ? null : "must be a number";
  return typeof v === "string" ? null : "must be text";
}

/** SELECT / WITH only, one statement; the child enforces the rest. */
export function checkSelect(sql: string): string {
  // ponytail: a ';' inside a string literal is refused too; comments are stripped first.
  const s = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(s)) throw new PersistenceError("refused", "only SELECT queries are allowed");
  if (s.includes(";")) throw new PersistenceError("refused", "one statement at a time");
  return s;
}

export interface PersistenceCoreOptions {
  dataDir: string;
  /** True while a game server is using the data dir. Default: never. */
  isServerRunning?: () => boolean;
  clock?: () => number;
}

export class PersistenceCore {
  private readonly adminDb: Database.Database;
  private readonly now: () => number;

  constructor(private readonly opts: PersistenceCoreOptions) {
    fs.mkdirSync(opts.dataDir, { recursive: true });
    this.now = opts.clock ?? Date.now;
    this.adminDb = new Database(path.join(opts.dataDir, "admin.db"));
    this.adminDb.pragma("journal_mode = WAL");
    this.adminDb.exec(`CREATE TABLE IF NOT EXISTS admin_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, admin TEXT NOT NULL,
      op TEXT NOT NULL, db TEXT NOT NULL, tbl TEXT NOT NULL,
      key TEXT NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL,
      undoes INTEGER, undone_by INTEGER)`);
  }

  close(): void {
    this.adminDb.close();
  }

  /** name → file for every game database (admin.db excluded). */
  private files(): Map<string, string> {
    const out = new Map<string, string>();
    const scan = (dir: string): void => {
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (f.endsWith(".db") && f !== "admin.db") out.set(f.slice(0, -3), path.join(dir, f));
      }
    };
    scan(this.opts.dataDir);
    scan(path.join(this.opts.dataDir, "navmesh"));
    return out;
  }

  private file(db: string): string {
    const f = this.files().get(db);
    if (!f) throw new PersistenceError("bad-request", `unknown database "${db}"`);
    return f;
  }

  private withRo<T>(db: string, fn: (d: Database.Database) => T): T {
    const d = new Database(this.file(db), { readonly: true, fileMustExist: true });
    try {
      return fn(d);
    } finally {
      d.close();
    }
  }

  catalog(): DbInfo[] {
    return [...this.files()].map(([name, file]) =>
      this.withRo(name, (d) => ({
        name,
        file: path.basename(file),
        bytes: fs.statSync(file).size,
        tables: this.tables(name, d),
      })),
    );
  }

  private tables(db: string, d: Database.Database): TableInfo[] {
    const names = d
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return names.map(({ name }) => {
      const cols = (d.pragma(`table_info(${quote(name)})`) as Array<{ name: string; type: string; notnull: number; pk: number }>).map(
        (c): ColumnInfo => ({
          name: c.name,
          type: c.type,
          notNull: c.notnull === 1,
          pk: c.pk,
          editable: c.pk === 0 && !/BLOB/i.test(c.type),
        }),
      );
      const rowCount = (d.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get() as { n: number }).n;
      const note = APPEND_ONLY.has(`${db}.${name}`)
        ? "append-only"
        : !cols.some((c) => c.pk > 0)
          ? "no primary key"
          : undefined;
      return { name, rowCount, columns: cols, editable: note === undefined, ...(note ? { note } : {}) };
    });
  }

  async query(db: string, sql: string, opts: { limit?: number; timeoutMs?: number } = {}): Promise<QueryResult> {
    const text = checkSelect(sql);
    const file = this.file(db);
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? QUERY_DEFAULT_ROWS)), QUERY_MAX_ROWS);
    const timeoutMs = opts.timeoutMs ?? QUERY_DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(new URL("./query-worker.js", import.meta.url)), [JSON.stringify({ file, sql: text, limit })], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new PersistenceError("timeout", `query exceeded ${timeoutMs} ms and was stopped`));
      }, timeoutMs);
      child.once("message", (m: { ok: boolean; error?: string } & QueryResult) => {
        clearTimeout(timer);
        if (m.ok) resolve({ columns: m.columns, rows: m.rows, truncated: m.truncated });
        else reject(new PersistenceError("refused", m.error ?? "query failed"));
      });
      child.once("error", (e: Error) => {
        clearTimeout(timer);
        reject(new PersistenceError("refused", e.message));
      });
    });
  }

  /** Validate a mutation against the live schema; returns the table. */
  private validate(m: Mutation, d: Database.Database): TableInfo {
    const t = this.tables(m.db, d).find((x) => x.name === m.table);
    if (!t) throw new PersistenceError("bad-request", `unknown table "${m.db}.${m.table}"`);
    if (!t.editable) throw new PersistenceError("refused", `${m.db}.${m.table} is not editable (${t.note})`);
    const pks = t.columns.filter((c) => c.pk > 0);
    const keyNames = Object.keys(m.key);
    if (keyNames.length !== pks.length || !pks.every((c) => keyNames.includes(c.name))) {
      throw new PersistenceError("bad-request", `key must be exactly ${pks.map((c) => c.name).join(", ")}`);
    }
    const setNames = Object.keys(m.set);
    if (setNames.length === 0) throw new PersistenceError("bad-request", "nothing to set");
    for (const n of setNames) {
      const c = t.columns.find((x) => x.name === n);
      if (!c) throw new PersistenceError("bad-request", `unknown column "${n}"`);
      if (!c.editable) throw new PersistenceError("refused", `column "${n}" is not editable`);
      const problem = checkValue(c, m.set[n] as SqlValue);
      if (problem) throw new PersistenceError("bad-request", `${n} ${problem}`);
    }
    return t;
  }

  private assertOffline(): void {
    if (this.opts.isServerRunning?.()) {
      throw new PersistenceError(
        "refused",
        "the game server is using this database; stop it first (live edits through the stores are not built yet)",
      );
    }
  }

  /**
   * Apply mutations atomically per database after a backup copy of each.
   * Every mutation is validated before anything is written.
   */
  async apply(admin: string, muts: Mutation[]): Promise<AdminLogEntry[]> {
    if (muts.length === 0) return [];
    const dbs = [...new Set(muts.map((m) => m.db))];
    for (const db of dbs) {
      this.assertOffline();
      this.withRo(db, (d) => muts.filter((m) => m.db === db).forEach((m) => this.validate(m, d)));
    }
    const out: AdminLogEntry[] = [];
    for (const db of dbs) {
      out.push(...(await this.write(admin, db, muts.filter((m) => m.db === db), "update", null)));
    }
    return out;
  }

  private async write(admin: string, db: string, muts: Mutation[], op: "update" | "undo", undoes: number | null): Promise<AdminLogEntry[]> {
    const d = new Database(this.file(db), { fileMustExist: true });
    try {
      const dir = path.join(this.opts.dataDir, "backups");
      fs.mkdirSync(dir, { recursive: true });
      await d.backup(path.join(dir, `${db}-${this.now()}.db`));
      const log: AdminLogEntry[] = [];
      d.transaction(() => {
        for (const m of muts) {
          const t = this.validate(m, d);
          const where = Object.keys(m.key).map((k) => `${quote(k)} = ?`).join(" AND ");
          const cols = Object.keys(m.set);
          const row = d.prepare(`SELECT ${cols.map(quote).join(", ")} FROM ${quote(m.table)} WHERE ${where}`).get(...Object.values(m.key)) as
            | Record<string, SqlValue>
            | undefined;
          if (!row) throw new PersistenceError("bad-request", `no row ${JSON.stringify(m.key)} in ${m.db}.${t.name}`);
          d.prepare(`UPDATE ${quote(m.table)} SET ${cols.map((c) => `${quote(c)} = ?`).join(", ")} WHERE ${where}`).run(
            ...cols.map((c) => m.set[c] as SqlValue),
            ...Object.values(m.key),
          );
          log.push(this.record(admin, op, m, row, undoes));
        }
      })();
      return log;
    } finally {
      d.close();
    }
  }

  private record(admin: string, op: "update" | "undo", m: Mutation, before: Record<string, SqlValue>, undoes: number | null): AdminLogEntry {
    const ts = this.now();
    const r = this.adminDb
      .prepare("INSERT INTO admin_log (ts, admin, op, db, tbl, key, before, after, undoes) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(ts, admin, op, m.db, m.table, JSON.stringify(m.key), JSON.stringify(before), JSON.stringify(m.set), undoes);
    return { id: Number(r.lastInsertRowid), ts, admin, op, db: m.db, table: m.table, key: m.key, before, after: m.set, undoes, undoneBy: null };
  }

  log(limit = 200): AdminLogEntry[] {
    const rows = this.adminDb.prepare("SELECT * FROM admin_log ORDER BY id DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      ts: r.ts as number,
      admin: r.admin as string,
      op: r.op as "update" | "undo",
      db: r.db as string,
      table: r.tbl as string,
      key: JSON.parse(r.key as string) as Record<string, SqlValue>,
      before: JSON.parse(r.before as string) as Record<string, SqlValue>,
      after: JSON.parse(r.after as string) as Record<string, SqlValue>,
      undoes: r.undoes as number | null,
      undoneBy: r.undone_by as number | null,
    }));
  }

  /** Reverse one logged update: restores its before-image unless the row changed since. */
  async undo(admin: string, id: number): Promise<AdminLogEntry> {
    const e = this.log(1_000_000).find((x) => x.id === id);
    if (!e) throw new PersistenceError("bad-request", `no log entry ${id}`);
    if (e.op !== "update") throw new PersistenceError("refused", "only an update can be undone");
    if (e.undoneBy !== null) throw new PersistenceError("conflict", `entry ${id} was already undone`);
    const inverse: Mutation = { db: e.db, table: e.table, key: e.key, set: e.before };
    this.assertOffline();
    const current = this.withRo(e.db, (d) => {
      this.validate(inverse, d);
      const where = Object.keys(e.key).map((k) => `${quote(k)} = ?`).join(" AND ");
      return d
        .prepare(`SELECT ${Object.keys(e.after).map(quote).join(", ")} FROM ${quote(e.table)} WHERE ${where}`)
        .get(...Object.values(e.key)) as Record<string, SqlValue> | undefined;
    });
    if (!current || Object.keys(e.after).some((k) => current[k] !== e.after[k])) {
      throw new PersistenceError("conflict", "the row changed since this edit; undo it by hand");
    }
    const [entry] = await this.write(admin, e.db, [inverse], "undo", id);
    this.adminDb.prepare("UPDATE admin_log SET undone_by = ? WHERE id = ?").run(entry.id, id);
    return entry;
  }
}
