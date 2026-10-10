/**
 * The world.db snapshot around one owned play server (Play menu
 * fresh/keep). The host calls begin() before the server starts, fail()
 * when the start does not come up, and end() after the server stopped.
 *
 * - Not keeping play changes (or fresh): back up world.db, and restore
 *   it on stop or on a failed start.
 * - Keeping play changes: no backup; the world keeps what the tick wrote.
 * - A backup left by a session that never ended (the editor host died
 *   mid-play) is the pre-play world: it is restored before the next
 *   start, never discarded and never overwritten by a new backup.
 */
import { backupWorld, discardBackup, hasBackup, restoreWorld } from "@mmo-engine/engine-core";

export interface PlaySnapshot {
  /** Before the server starts. Returns a note when it recovered a leftover backup. */
  begin(opts: { fresh: boolean; keep: boolean }): string | undefined;
  /** The start failed: put the pre-play world back. */
  fail(): void;
  /** The server stopped: restore, or keep what play wrote. */
  end(): void;
}

export function createPlaySnapshot(dbPath: string): PlaySnapshot {
  let active = false;
  let keep = false;
  return {
    begin(opts) {
      let note: string | undefined;
      if (!active && hasBackup(dbPath)) {
        restoreWorld(dbPath);
        note = "restored the world saved before an earlier play session that did not stop cleanly";
      }
      if (active) return note;
      if (opts.fresh || !opts.keep) {
        backupWorld(dbPath);
        active = true;
        keep = opts.keep;
      }
      return note;
    },
    fail() {
      if (!active) return;
      restoreWorld(dbPath);
      active = false;
    },
    end() {
      if (!active) return;
      if (keep) discardBackup(dbPath);
      else restoreWorld(dbPath);
      active = false;
    },
  };
}
