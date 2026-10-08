/**
 * Child process for PersistenceCore.query: opens the file read-only, runs one
 * SELECT, returns at most `limit` rows over IPC. It is its own process so a
 * heavy statement can be killed on timeout: better-sqlite3 runs synchronous
 * native code, which a worker thread cannot be stopped inside.
 * Job (JSON) arrives as argv[2].
 */
import Database from "better-sqlite3";

interface Job {
  file: string;
  sql: string;
  limit: number;
}

const { file, sql, limit } = JSON.parse(process.argv[2]) as Job;
const db = new Database(file, { readonly: true, fileMustExist: true });
let reply: unknown;
try {
  db.pragma("query_only = ON");
  const stmt = db.prepare(sql);
  // A statement that does not return rows (WITH … DELETE, PRAGMA writes) is not a query.
  if (!stmt.reader) throw new Error("not a read query");
  const columns = stmt.columns().map((c) => c.name);
  const rows: unknown[][] = [];
  let truncated = false;
  for (const row of stmt.raw(true).iterate() as Iterable<unknown[]>) {
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
    rows.push(row.map((v) => (Buffer.isBuffer(v) ? `<blob ${v.length} bytes>` : typeof v === "bigint" ? Number(v) : v)));
  }
  reply = { ok: true, columns, rows, truncated };
} catch (e) {
  reply = { ok: false, error: (e as Error).message };
} finally {
  db.close();
}
process.send?.(reply, () => process.exit(0));
