/** Browser-side calls to the dev host's /api/editor/database routes (see database-host.ts). */
import type { Mutation, SqlValue, Table } from "./database-model.js";

export interface Db {
  name: string;
  file: string;
  bytes: number;
  tables: Table[];
}
export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}
export interface LogEntry {
  id: number;
  ts: number;
  admin: string;
  op: "update" | "undo";
  db: string;
  table: string;
  key: Record<string, SqlValue>;
  before: Record<string, SqlValue>;
  after: Record<string, SqlValue>;
  undoes: number | null;
  undoneBy: number | null;
}

async function call<T>(route: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/editor/database/${route}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

export const fetchCatalog = async (): Promise<Db[]> => (await call<{ databases: Db[] }>("catalog")).databases;
export const runQuery = async (db: string, sql: string, limit?: number): Promise<QueryResult> =>
  (await call<{ result: QueryResult }>("query", { db, sql, limit })).result;
export const applyMutations = async (mutations: Mutation[]): Promise<LogEntry[]> =>
  (await call<{ entries: LogEntry[] }>("apply", { mutations })).entries;
export const fetchLog = async (): Promise<LogEntry[]> => (await call<{ log: LogEntry[] }>("log")).log;
export const undoEntry = async (id: number): Promise<LogEntry> => (await call<{ entry: LogEntry }>("undo", { id })).entry;
