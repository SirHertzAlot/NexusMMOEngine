/**
 * Background WAL checkpointer for SnapshotStore.
 *
 * A checkpoint folds WAL pages back into the main DB file and fsyncs it —
 * the only slow part of a save (measured ~4-5 ms on Windows, where
 * FlushFileBuffers is expensive, vs ~0.4 ms for the commit itself). It
 * runs here, on its own connection, so the fsync never stalls the tick
 * thread. PASSIVE checkpoints never wait on the writer and the writer
 * never waits on them: SQLite's WAL locking makes the two connections
 * safe to run concurrently.
 *
 * Protocol (from SnapshotStore): "checkpoint" -> runs one PASSIVE
 * checkpoint, replies "done" (or "failed" with the reason); "close" ->
 * closes the connection and exits.
 */

import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";

const { dbPath, walSizeLimitBytes } = workerData as {
  dbPath: string;
  walSizeLimitBytes: number;
};
const port = parentPort!;
const db = new Database(dbPath);
// A concurrent commit can hold the WAL briefly; wait instead of erroring.
db.pragma("busy_timeout = 1000");
// Truncate the WAL back to the limit after checkpoints this connection
// runs (the setting is per connection; the store sets it on its own too).
db.pragma(`journal_size_limit = ${Math.floor(walSizeLimitBytes)}`);
const checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");

port.on("message", (msg: unknown) => {
  if (msg === "checkpoint") {
    try {
      checkpoint.get();
      port.postMessage("done");
    } catch (err) {
      port.postMessage({ failed: (err as Error).message });
    }
  } else if (msg === "close") {
    db.close();
    port.close();
  }
});
