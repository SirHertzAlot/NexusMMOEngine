/**
 * Database workspace routes for the editor dev host (roadmap EA16).
 *
 * Admin-only by construction: the host answers /api/editor/* to loopback
 * connections only (host.ts), and the mutating routes also demand a JSON
 * content type so a cross-site form post cannot reach them. No account
 * system is involved; the engine-core PersistenceCore is loaded by file
 * from the built engine-core and never bundled into Vite.
 *
 *   GET  /api/editor/database/catalog          → databases, tables, columns
 *   POST /api/editor/database/query            → { db, sql, limit? } SELECT only
 *   POST /api/editor/database/apply            → { mutations: Mutation[] } maintenance mode
 *   GET  /api/editor/database/log              → admin_log, newest first
 *   POST /api/editor/database/undo             → { id }
 *   GET  /api/editor/database/functions        → EA17 stored read-only functions + load problems
 *   POST /api/editor/database/functions        → { name, db, sql, description? } validate + store
 *   POST /api/editor/database/functions/run    → { name, params? } bind and run
 *   GET  /api/editor/database/caches           → EA17 snapshot caches + freshness
 *   POST /api/editor/database/cache/refresh    → { name } rebuild one snapshot (maintenance mode)
 *
 * Mutations need the game server stopped (see PersistenceCore); live edits
 * through the server's stores are deferred.
 */

import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The slice of engine-core's PersistenceCore this host uses. */
export interface DatabaseCore {
  catalog(): unknown;
  query(db: string, sql: string, opts?: { limit?: number }): Promise<unknown>;
  apply(admin: string, muts: unknown[]): Promise<unknown>;
  log(limit?: number): unknown;
  undo(admin: string, id: number): Promise<unknown>;
  /** EA17: stored read-only functions. */
  listDbFunctions(): unknown;
  runDbFunction(name: string, params: Record<string, unknown>): Promise<unknown>;
  createDbFunction(input: { name: string; db: string; sql: string; description?: string }): Promise<unknown>;
  /** EA17: snapshot caches. */
  listDbCaches(): unknown;
  refreshDbCache(name: string): Promise<unknown>;
}

export interface DatabaseRequest {
  method: string;
  /** Path after /api/editor/database/ */
  route: string;
  contentType?: string;
  body: unknown;
}
export interface DatabaseDeps {
  core: DatabaseCore;
  /** True while a game server holds the data dir (mutations are refused). */
  serverRunning(): Promise<boolean>;
}
export interface DatabaseReply {
  status: number;
  body: unknown;
}

export const ADMIN = "editor";
const STATUS = { "bad-request": 400, refused: 403, timeout: 408, conflict: 409 } as const;

export async function handleDatabase(deps: DatabaseDeps, req: DatabaseRequest): Promise<DatabaseReply> {
  const obj = (req.body ?? {}) as Record<string, unknown>;
  try {
    if (req.method === "GET" && req.route === "catalog") return ok({ databases: deps.core.catalog() });
    if (req.method === "GET" && req.route === "log") return ok({ log: deps.core.log(200) });
    if (req.method === "GET" && req.route === "functions") return ok({ functions: deps.core.listDbFunctions() });
    if (req.method === "GET" && req.route === "caches") return ok({ caches: deps.core.listDbCaches() });
    if (req.method !== "POST") return { status: 404, body: { ok: false, error: "not found" } };
    if (!/^application\/json\b/i.test(req.contentType ?? "")) {
      return { status: 415, body: { ok: false, error: "send application/json" } };
    }
    if (req.route === "query") {
      if (typeof obj.db !== "string" || typeof obj.sql !== "string") return bad("need { db, sql }");
      const limit = typeof obj.limit === "number" ? obj.limit : undefined;
      return ok({ result: await deps.core.query(obj.db, obj.sql, { limit }) });
    }
    if (req.route === "apply") {
      if (!Array.isArray(obj.mutations)) return bad("need { mutations: [] }");
      if (await deps.serverRunning()) {
        return { status: 409, body: { ok: false, error: "the game server is running; stop it to edit data (live edits are not built yet)" } };
      }
      return ok({ entries: await deps.core.apply(ADMIN, obj.mutations) });
    }
    if (req.route === "undo") {
      if (typeof obj.id !== "number") return bad("need { id }");
      if (await deps.serverRunning()) {
        return { status: 409, body: { ok: false, error: "the game server is running; stop it to undo" } };
      }
      return ok({ entry: await deps.core.undo(ADMIN, obj.id) });
    }
    if (req.route === "functions") {
      if (typeof obj.name !== "string" || typeof obj.db !== "string" || typeof obj.sql !== "string") {
        return bad("need { name, db, sql, description? }");
      }
      if (obj.description !== undefined && typeof obj.description !== "string") return bad("description must be a string");
      return ok({
        function: await deps.core.createDbFunction({
          name: obj.name,
          db: obj.db,
          sql: obj.sql,
          ...(typeof obj.description === "string" ? { description: obj.description } : {}),
        }),
      });
    }
    if (req.route === "functions/run") {
      if (typeof obj.name !== "string") return bad("need { name, params? }");
      const params = obj.params === undefined ? {} : obj.params;
      if (typeof params !== "object" || params === null || Array.isArray(params)) return bad("params must be an object");
      return ok({ result: await deps.core.runDbFunction(obj.name, params as Record<string, unknown>) });
    }
    if (req.route === "cache/refresh") {
      if (typeof obj.name !== "string") return bad("need { name }");
      if (await deps.serverRunning()) {
        return { status: 409, body: { ok: false, error: "the game server is running; stop it to refresh caches" } };
      }
      return ok({ cache: await deps.core.refreshDbCache(obj.name) });
    }
    return { status: 404, body: { ok: false, error: "not found" } };
  } catch (e) {
    const code = (e as { code?: keyof typeof STATUS }).code;
    return { status: (code && STATUS[code]) || 500, body: { ok: false, error: (e as Error).message } };
  }
}

const ok = (b: Record<string, unknown>): DatabaseReply => ({ status: 200, body: { ok: true, ...b } });
const bad = (error: string): DatabaseReply => ({ status: 400, body: { ok: false, error } });

/** Load the built engine-core PersistenceCore for a data dir (by file, never bundled). */
export async function openDatabaseCore(repoRoot: string, dataDir: string): Promise<DatabaseCore> {
  const file = join(repoRoot, "packages", "engine-core", "dist", "src", "persist", "persistence-core.js");
  if (!existsSync(file)) {
    throw Object.assign(new Error("persistence core not built — run: npm run build --workspace=@mmo-engine/engine-core"), { status: 500 });
  }
  const mod = (await import(pathToFileURL(file).href)) as {
    PersistenceCore: new (o: { dataDir: string; contentDir?: string }) => DatabaseCore;
  };
  return new mod.PersistenceCore({ dataDir, contentDir: join(repoRoot, "content") });
}

/** True when something accepts connections on the game server's port. */
export function portOpen(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
  });
}
