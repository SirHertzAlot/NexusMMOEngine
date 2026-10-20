/**
 * EA17: database functions and caches — the SQLite edition.
 *
 * SQLite has no CREATE FUNCTION and no materialized views, so the design
 * doc's PostgreSQL-flavoured DDL is adapted to what SQLite can actually do:
 *
 *  - A "function" is a named, parameterized, read-only SELECT stored as
 *    `content/db/functions/<name>.sql`. The file opens with `-- key: value`
 *    headers (`db:` required, `description:` optional), then exactly one
 *    SELECT/WITH statement. Parameters are `:name` placeholders, bound at
 *    run time. Anything that is not a single read-only statement is refused
 *    at load: a function can never mutate the database.
 *  - A "cache" is a snapshot table `_cache_<name>` inside the target
 *    database, built from `content/db/caches/<name>.sql` (same header
 *    format; parameters are refused — a snapshot has nothing to bind).
 *    Refresh is DELETE + re-INSERT in one transaction, so readers never see
 *    a half-built snapshot. The `_cache_meta` table tracks each cache's
 *    source SQL, last refresh time and row count.
 *
 * Validation happens at load and every problem is collected, never thrown,
 * so one bad file cannot take down the registry (same posture as
 * discoverModules in packages/modules).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PersistenceError, checkSelect, type SqlValue } from "./persistence-core.js";

/** Segments under the content dir. */
export const FUNCTIONS_DIR = "db/functions";
export const CACHES_DIR = "db/caches";
/** Snapshot tables are `_cache_<name>`; this tracks their freshness. */
export const CACHE_META_TABLE = "_cache_meta";
export const cacheTableName = (name: string): string => `_cache_${name}`;

export interface DbFunctionDef {
  name: string;
  db: string;
  description?: string;
  /** Cleaned single SELECT/WITH statement; `:name` placeholders intact. */
  sql: string;
  /** Parameter names in first-seen order. */
  params: string[];
}

export interface DbCacheDef {
  name: string;
  db: string;
  description?: string;
  /** Cleaned single SELECT/WITH statement; never has parameters. */
  sql: string;
}

export interface DbFileProblem {
  file: string;
  message: string;
}

export interface DbFunctionSummary {
  name: string;
  db: string;
  description?: string;
  params: string[];
}

export interface DbCacheSummary {
  name: string;
  db: string;
  description?: string;
  lastRefreshed: number | null;
  rowCount: number | null;
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const DB_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;
const HEADER_RE = /^--\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/;

const bad = (file: string, message: string): DbFileProblem => ({ file, message });

/**
 * Parameter names in first-seen order. `:name`-looking text inside string
 * literals is not a parameter.
 */
export function extractParams(sql: string): string[] {
  const dequoted = sql.replace(/'(?:[^']|'')*'/g, "''");
  const out: string[] = [];
  for (const m of dequoted.matchAll(PARAM_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Split the leading `-- key: value` header block from the SQL body. */
function splitHeaders(file: string, content: string): { headers: Map<string, string>; body: string; problems: DbFileProblem[] } {
  const headers = new Map<string, string>();
  const problems: DbFileProblem[] = [];
  const lines = content.split("\n");
  let i = 0;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "") continue;
    const m = HEADER_RE.exec(t);
    if (!m) break;
    const key = m[1].toLowerCase();
    if (headers.has(key)) problems.push(bad(file, `duplicate header "${key}"`));
    else headers.set(key, m[2]);
  }
  return { headers, body: lines.slice(i).join("\n"), problems };
}

type Parsed = { def?: DbFunctionDef | DbCacheDef; problems: DbFileProblem[] };

function parseDef(file: string, content: string, kind: "function" | "cache"): Parsed {
  const problems: DbFileProblem[] = [];
  const name = basename(file, ".sql");
  if (!NAME_RE.test(name)) {
    problems.push(bad(file, `name "${name}" must be lowercase letters, digits and underscores, starting with a letter`));
  }
  const { headers, body, problems: hp } = splitHeaders(file, content);
  problems.push(...hp);
  const db = headers.get("db") ?? "";
  if (!DB_RE.test(db)) problems.push(bad(file, `header "db:" is required and must name a database`));
  for (const k of headers.keys()) {
    if (k !== "db" && k !== "description") problems.push(bad(file, `unknown header "${k}"`));
  }
  let sql = "";
  try {
    sql = checkSelect(body);
  } catch (e) {
    problems.push(bad(file, (e as Error).message));
  }
  const params = sql ? extractParams(sql) : [];
  if (kind === "cache" && params.length > 0) {
    problems.push(bad(file, `caches take no parameters, but the query uses ${params.map((p) => `":${p}"`).join(", ")}`));
  }
  if (problems.length > 0) return { problems };
  const description = headers.get("description");
  if (kind === "function") {
    const def: DbFunctionDef = { name, db, sql, params };
    if (description) def.description = description;
    return { def, problems };
  }
  const def: DbCacheDef = { name, db, sql };
  if (description) def.description = description;
  return { def, problems };
}

/** Parse one function file; problems are returned, never thrown. */
export function parseFunctionFile(file: string, content: string): { def?: DbFunctionDef; problems: DbFileProblem[] } {
  const r = parseDef(file, content, "function");
  return { def: r.def as DbFunctionDef | undefined, problems: r.problems };
}

/** Parse one cache file; problems are returned, never thrown. */
export function parseCacheFile(file: string, content: string): { def?: DbCacheDef; problems: DbFileProblem[] } {
  const r = parseDef(file, content, "cache");
  return { def: r.def as DbCacheDef | undefined, problems: r.problems };
}

function loadDir(dir: string, kind: "function" | "cache"): { defs: Array<DbFunctionDef | DbCacheDef>; problems: DbFileProblem[] } {
  const defs: Array<DbFunctionDef | DbCacheDef> = [];
  const problems: DbFileProblem[] = [];
  if (!existsSync(dir)) return { defs, problems };
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    let content: string;
    try {
      content = readFileSync(join(dir, f), "utf8");
    } catch (e) {
      problems.push(bad(f, `cannot read: ${(e as Error).message}`));
      continue;
    }
    const r = parseDef(f, content, kind);
    if (r.def) defs.push(r.def);
    problems.push(...r.problems);
  }
  return { defs, problems };
}

/** Validate every `*.sql` in `dir`; one bad file never fails the rest. */
export function loadDbFunctions(dir: string): { functions: DbFunctionDef[]; problems: DbFileProblem[] } {
  const { defs, problems } = loadDir(dir, "function");
  return { functions: defs as DbFunctionDef[], problems };
}

/** Validate every `*.sql` in `dir`; one bad file never fails the rest. */
export function loadDbCaches(dir: string): { caches: DbCacheDef[]; problems: DbFileProblem[] } {
  const { defs, problems } = loadDir(dir, "cache");
  return { caches: defs as DbCacheDef[], problems };
}

/** Render a function definition back to the on-disk file format. */
export function serializeFunctionFile(def: { db: string; description?: string; sql: string }): string {
  const head = [`-- db: ${def.db}`, ...(def.description ? [`-- description: ${def.description}`] : [])];
  return `${head.join("\n")}\n${def.sql.trim()}\n`;
}

/** Write a new function file after validation; throws PersistenceError when invalid. */
export function writeFunctionFile(
  dir: string,
  input: { name: string; db: string; sql: string; description?: string },
): DbFunctionDef {
  const file = `${input.name}.sql`;
  const { def, problems } = parseFunctionFile(file, serializeFunctionFile(input));
  if (!def) throw new PersistenceError("bad-request", problems.map((p) => p.message).join("; "));
  mkdirSync(dir, { recursive: true });
  const target = join(dir, file);
  if (existsSync(target)) throw new PersistenceError("conflict", `function "${def.name}" already exists`);
  writeFileSync(target, serializeFunctionFile(input), "utf8");
  return def;
}

/** Throw unless every declared parameter is bound to a SqlValue, with no extras. */
export function checkParams(def: DbFunctionDef, params: Record<string, SqlValue>): void {
  for (const p of def.params) {
    if (!(p in params)) throw new PersistenceError("bad-request", `missing parameter ":${p}"`);
  }
  for (const k of Object.keys(params)) {
    if (!def.params.includes(k)) throw new PersistenceError("bad-request", `unknown parameter ":${k}"`);
    const v = params[k];
    if (v !== null && typeof v !== "string" && typeof v !== "number") {
      throw new PersistenceError("bad-request", `parameter ":${k}" must be a string, number or null`);
    }
  }
}

/** One row of EXPLAIN QUERY PLAN output. */
export interface QueryPlanNode {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

/**
 * EA17: check a function's query plan for full table scans.
 *
 * Runs EXPLAIN QUERY PLAN on the function's SQL (with NULL bound for every
 * parameter) and returns a warning for each SCAN without a USING INDEX.
 * Expression indexes (e.g. `CREATE INDEX i ON t(expr(x))`) appear as
 * `USING INDEX` in the plan when the query's WHERE matches the expression.
 *
 * Returns an empty array when the plan is clean. The `db` callback runs the
 * EXPLAIN; the caller supplies it so this stays testable without a real DB.
 */
export function checkQueryPlan(
  def: DbFunctionDef,
  explain: (sql: string, params: Record<string, null>) => QueryPlanNode[],
): string[] {
  const warnings: string[] = [];
  const nullParams = Object.fromEntries(def.params.map((p) => [p, null]));
  let plan: QueryPlanNode[];
  try {
    plan = explain(`EXPLAIN QUERY PLAN ${def.sql}`, nullParams);
  } catch (e) {
    // If EXPLAIN fails (e.g. the SQL references a missing table), that's a
    // load-time problem, not a plan problem — report it as such.
    return [`cannot explain query plan: ${e instanceof Error ? e.message : String(e)}`];
  }
  for (const node of plan) {
    const d = node.detail;
    // "SCAN t" without "USING INDEX" = full table scan.
    // "SCAN t USING INDEX i" or "SEARCH t USING INDEX i" = indexed.
    if (/^SCAN\s/i.test(d) && !/USING\s+INDEX/i.test(d)) {
      const table = d.replace(/^SCAN\s+/i, "").trim().split(/\s/)[0];
      warnings.push(
        `function "${def.name}": full table scan on "${table}" — consider an index (expression indexes help for WHERE on computed values)`,
      );
    }
  }
  return warnings;
}
