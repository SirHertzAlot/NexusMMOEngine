/**
 * World snapshot/restore for the Play menu's fresh/keep options.
 *
 * The owned server persists to world.db. Before the server starts, the
 * db is backed up; on stop, the backup is restored unless "keep play
 * changes" is set, in which case the backup is discarded and the world
 * keeps what the tick wrote.
 *
 * world.db runs in WAL mode, so its state is the db file plus its -wal
 * (and -shm) sidecars: a backup copies all three, and a restore removes
 * the play session's sidecars before putting the backup back. A world
 * that did not exist yet is recorded as absent, and restoring it removes
 * whatever the play session created.
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** SQLite's WAL-mode sidecar suffixes. */
const SIDECARS = ["-wal", "-shm"] as const;

/** Where the backup lives: alongside the db, with a .bak suffix. */
export function snapshotPath(dbPath: string): string {
  return `${dbPath}.bak`;
}

/** Marker for "there was no world before play". */
function absentMarker(dbPath: string): string {
  return `${dbPath}.bak-absent`;
}

function backupFiles(dbPath: string): string[] {
  const snap = snapshotPath(dbPath);
  return [snap, ...SIDECARS.map((s) => `${snap}${s}`), absentMarker(dbPath)];
}

/** True when a backup (or an absent marker) is waiting to be restored or discarded. */
export function hasBackup(dbPath: string): boolean {
  return existsSync(snapshotPath(dbPath)) || existsSync(absentMarker(dbPath));
}

/**
 * Back up the world db and its sidecars, replacing any earlier backup.
 * Returns the snapshot path. When the db does not exist yet, records
 * that instead, so a restore can remove what play creates.
 */
export function backupWorld(dbPath: string): string {
  const snap = snapshotPath(dbPath);
  discardBackup(dbPath);
  if (existsSync(dbPath)) {
    copyFileSync(dbPath, snap);
    for (const s of SIDECARS) {
      if (existsSync(`${dbPath}${s}`)) copyFileSync(`${dbPath}${s}`, `${snap}${s}`);
    }
  } else {
    // A fresh checkout has no data dir yet; the marker has to land somewhere.
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(absentMarker(dbPath), "");
  }
  return snap;
}

/**
 * Restore the backup over the db (the server must have stopped). No-op
 * (no throw) when there is no backup.
 */
export function restoreWorld(dbPath: string): void {
  const snap = snapshotPath(dbPath);
  if (existsSync(snap)) {
    // The play session's -wal would otherwise be replayed onto the old db.
    for (const s of SIDECARS) rmSync(`${dbPath}${s}`, { force: true });
    renameSync(snap, dbPath);
    for (const s of SIDECARS) {
      if (existsSync(`${snap}${s}`)) renameSync(`${snap}${s}`, `${dbPath}${s}`);
    }
  } else if (existsSync(absentMarker(dbPath))) {
    for (const f of [dbPath, ...SIDECARS.map((s) => `${dbPath}${s}`)]) rmSync(f, { force: true });
  }
  discardBackup(dbPath);
}

/** Discard the backup (keep what the tick wrote). No-op when absent. */
export function discardBackup(dbPath: string): void {
  for (const f of backupFiles(dbPath)) rmSync(f, { force: true });
}
