/**
 * World snapshot/restore for the Play menu's fresh/keep options.
 *
 * The owned server persists to world.db. "Fresh state" backs the db up
 * before the server starts (a clean world boots); on stop, the backup
 * is restored unless "keep play changes" is set, in which case the
 * backup is discarded and the world keeps what the tick wrote.
 */
import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";

/** Where the backup lives: alongside the db, with a .bak suffix. */
export function snapshotPath(dbPath: string): string {
  return `${dbPath}.bak`;
}

/**
 * Back up the world db. Returns the snapshot path. No-op (no throw)
 * when the db does not exist yet.
 */
export function backupWorld(dbPath: string): string {
  const snap = snapshotPath(dbPath);
  if (existsSync(dbPath)) {
    copyFileSync(dbPath, snap);
  }
  return snap;
}

/**
 * Restore the backup over the db. No-op (no throw) when there is no
 * backup.
 */
export function restoreWorld(dbPath: string): void {
  const snap = snapshotPath(dbPath);
  if (existsSync(snap)) {
    renameSync(snap, dbPath);
  }
}

/** Discard the backup (keep what the tick wrote). No-op when absent. */
export function discardBackup(dbPath: string): void {
  const snap = snapshotPath(dbPath);
  if (existsSync(snap)) {
    rmSync(snap);
  }
}
