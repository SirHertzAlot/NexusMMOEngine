/**
 * Server settings an operator or designer tunes without a developer
 * (content/server/, roadmap EG13): how often the world is saved and how
 * much the save history and database queries may hold. Read when the
 * server starts; the editor's Live ops › Server settings edits them, and
 * its Database query reads the query limits on every query.
 * `MMO_SERVER_SETTINGS` overrides the folder.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const DEFAULT_SERVER_SETTINGS_DIR = fileURLToPath(new URL("../../../../content/server", import.meta.url));

/** content/server/persistence.json. Every field has the engine's old constant as its default. */
export const PersistenceSettingsSchema = z
  .strictObject({
    /** The world is saved this often, seconds (10: every 300 ticks at 30 Hz). */
    saveEverySeconds: z.number().positive().max(3600).default(10),
    /** Newest snapshots kept; older ones are pruned after each save. */
    keepSnapshots: z.number().int().min(1).max(1000).default(6),
    /** The save log is truncated back to this after a checkpoint, megabytes. */
    walLimitMb: z.number().positive().max(1024).default(4),
    /** Rows a database query returns when it asks for no limit. */
    queryDefaultRows: z.number().int().min(1).default(500),
    /** Most rows any database query returns. */
    queryMaxRows: z.number().int().min(1).max(1_000_000).default(5000),
    /** A database query running longer than this is stopped, seconds. */
    queryTimeoutSeconds: z.number().positive().max(600).default(2),
  })
  .refine((s) => s.queryDefaultRows <= s.queryMaxRows, { message: "the default rows can't be above the most rows", path: ["queryDefaultRows"] });

export type PersistenceSettings = z.infer<typeof PersistenceSettingsSchema>;

export const DEFAULT_PERSISTENCE_SETTINGS: Readonly<PersistenceSettings> = Object.freeze(PersistenceSettingsSchema.parse({}));

/**
 * persistence.json in `dir` (default content/server): absent is the
 * defaults; a file that fails its checks is reported and the defaults used,
 * so a bad edit never stops a server.
 */
export function loadPersistenceSettings(dir: string = DEFAULT_SERVER_SETTINGS_DIR): { settings: PersistenceSettings; problem: string | null } {
  const file = path.join(dir, "persistence.json");
  if (!fs.existsSync(file)) return { settings: DEFAULT_PERSISTENCE_SETTINGS, problem: null };
  try {
    const r = PersistenceSettingsSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (r.success) return { settings: r.data, problem: null };
    return { settings: DEFAULT_PERSISTENCE_SETTINGS, problem: `${file}: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` };
  } catch (e) {
    return { settings: DEFAULT_PERSISTENCE_SETTINGS, problem: `${file}: ${(e as Error).message}` };
  }
}
