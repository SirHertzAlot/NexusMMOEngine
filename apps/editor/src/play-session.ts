/**
 * A play session's working copy of the world (EA14, host side).
 *
 * Play never runs on the saved world directly. Each start builds
 * `<dataDir>/play-session/` and points the server at it (MMO_DATA_DIR):
 *
 *  - baked, read-only data (navmesh, loot, dungeons, ...) is copied as is;
 *  - "continue the saved world" also copies the state files (*.db and their
 *    WAL/SHM), "fresh" copies only the terrain and navigation tables of
 *    world.db and none of the characters, quests, guilds or ledger;
 *  - accounts come from a scratch CSV in the session folder, never the
 *    real users.csv (which is not copied);
 *  - on stop, "keep" writes the session's state files back over the saved
 *    world, otherwise the session folder is simply deleted.
 *
 * Nothing here reads users.csv.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const SESSION_DIR_NAME = "play-session";
/** World state: SQLite files and their write-ahead logs. */
export const isStateFile = (name: string): boolean => /\.db(-wal|-shm|-journal)?$/.test(name);
/** Never copied: accounts, the pid file, the session folder itself. */
const SKIP = new Set(["users.csv", "editor-login.json", "server.pid", SESSION_DIR_NAME]);
/** What a fresh world keeps of world.db: the terrain and the navigation mesh. */
const FRESH_KEEPS = ["terrain_tiles", "world_maps", "formation_tiles_v2", "navmesh_tiles"];

export interface SqliteLike {
  prepare(sql: string): { all(): Array<Record<string, unknown>>; run(): unknown };
  exec(sql: string): unknown;
  close(): void;
}
export type OpenDb = (file: string) => Promise<SqliteLike>;

/** Keep the terrain tables of a copied world.db and empty everything else (entities, ledger, snapshots, sessions). */
export async function freshenWorldDb(file: string, openDb: OpenDb): Promise<void> {
  const db = await openDb(file);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    for (const t of tables) {
      const name = String(t.name);
      if (FRESH_KEEPS.includes(name) || name === "meta") continue;
      db.exec(`DELETE FROM "${name.replace(/"/g, '""')}"`);
    }
    db.exec("DELETE FROM meta WHERE key = 'saved_at_tick'");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

export interface PrepareOptions {
  dataDir: string;
  fresh: boolean;
  openDb: OpenDb;
}

/** Build a clean session folder from the saved data folder; returns its path. */
export async function prepareSession(o: PrepareOptions): Promise<string> {
  const dir = join(o.dataDir, SESSION_DIR_NAME);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (!existsSync(o.dataDir)) return dir;
  for (const name of readdirSync(o.dataDir)) {
    if (SKIP.has(name)) continue;
    const from = join(o.dataDir, name);
    if (statSync(from).isDirectory()) cpSync(from, join(dir, name), { recursive: true });
    else if (!isStateFile(name)) copyFileSync(from, join(dir, name));
    else if (!o.fresh || name.startsWith("world.db")) copyFileSync(from, join(dir, name));
  }
  if (o.fresh && existsSync(join(dir, "world.db"))) {
    // Open applies the copied WAL, so the newest terrain edits are in before everything else is emptied.
    await freshenWorldDb(join(dir, "world.db"), o.openDb);
  }
  return dir;
}

/** End a session: keep copies its state files over the saved world, then the folder goes either way. */
export function finishSession(dataDir: string, keep: boolean): { kept: string[] } {
  const dir = join(dataDir, SESSION_DIR_NAME);
  const kept: string[] = [];
  if (keep && existsSync(dir)) {
    const names = readdirSync(dir).filter(isStateFile);
    // Replace whole database sets: a stale -wal beside a new main file would corrupt it.
    const bases = new Set(names.map((n) => n.replace(/-(wal|shm|journal)$/, "")));
    for (const base of bases) for (const ext of ["", "-wal", "-shm", "-journal"]) rmSync(join(dataDir, `${base}${ext}`), { force: true });
    for (const n of names) {
      copyFileSync(join(dir, n), join(dataDir, n));
      kept.push(n);
    }
  }
  rmSync(dir, { recursive: true, force: true });
  return { kept };
}

/** Account names for a session's clients: play-1 .. play-N. */
export const accountNames = (clients: number): string[] => Array.from({ length: clients }, (_, i) => `play-${i + 1}`);
