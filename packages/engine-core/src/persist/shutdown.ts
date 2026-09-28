/**
 * Graceful-shutdown hook (slice 1.4).
 *
 * Installs SIGTERM/SIGINT handlers that save the current world state
 * and close the store before exiting. Synchronous all the way down
 * (better-sqlite3), so the save is guaranteed complete before
 * process.exit().
 *
 * Returns an uninstall function — call it in tests or when the server
 * takes over lifecycle management so handlers never leak between
 * worlds in one process.
 */

import type { SnapshotStore, SaveResult } from "./store.js";
import type { SimWorld } from "../world.js";

/** Read the live server state at signal time (must be cheap/synchronous). */
export type ShutdownStateReader = () => { tick: number; sim: SimWorld };

export interface ShutdownHookOptions {
  /** Fired after the shutdown save commits (logging, test hooks). */
  onSaved?: (result: SaveResult, signal: string) => void;
  /** Fired when the shutdown save throws; the process still exits. */
  onError?: (err: unknown, signal: string) => void;
}

/**
 * Install the SIGTERM/SIGINT handlers. A second signal while a
 * shutdown is already in progress force-exits(1) — the first handler
 * is fully synchronous, so this only fires if exit itself is delayed.
 */
export function installShutdownHook(
  store: SnapshotStore,
  readState: ShutdownStateReader,
  opts: ShutdownHookOptions = {},
): () => void {
  let shuttingDown = false;

  const handler = (signal: string): void => {
    if (shuttingDown) {
      process.exit(1);
      return;
    }
    shuttingDown = true;
    try {
      const { tick, sim } = readState();
      const result = store.saveWorld(tick, sim);
      opts.onSaved?.(result, signal);
    } catch (err) {
      opts.onError?.(err, signal);
    } finally {
      try {
        store.close();
      } catch {
        // Closing twice or on a dead handle must not block the exit.
      }
    }
    process.exit(0);
  };

  const onTerm = (): void => handler("SIGTERM");
  const onInt = (): void => handler("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  return () => {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  };
}
