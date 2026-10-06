/**
 * Where a region keeps the dungeon runs it committed (roadmap D4):
 * `<data>/instances.db`, one row per run with its whole result batch.
 * `unreported` rows are the batch for the world server's next report
 * (the region→world call is the edge/core work's to add); `markReported`
 * clears them.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import type { InstanceResult } from "./instance.js";

export interface InstanceResultStore {
  record(result: InstanceResult, granted: number, lost: number): void;
  unreported(): InstanceResult[];
  markReported(instances: readonly string[]): void;
}

/**
 * Flush the region's unreported dungeon runs to the world (roadmap D4):
 * sends the whole `unreported()` batch and marks only the instance ids
 * the world confirmed ingested. An empty batch sends nothing. A failed
 * report throws and marks nothing, so the batch retries on the next
 * flush. Runs off the tick loop (the server's 1 s save timer).
 */
export async function flushInstanceResults(
  store: InstanceResultStore,
  report: (results: InstanceResult[]) => Promise<readonly string[]>,
): Promise<{ reported: number }> {
  const batch = store.unreported();
  if (batch.length === 0) return { reported: 0 };
  const ingested = await report(batch);
  store.markReported(ingested);
  return { reported: ingested.length };
}

export class MemoryInstanceResultStore implements InstanceResultStore {
  readonly rows: { result: InstanceResult; granted: number; lost: number; reported: boolean }[] = [];
  record(result: InstanceResult, granted: number, lost: number): void {
    this.rows.push({ result: structuredClone(result), granted, lost, reported: false });
  }
  unreported(): InstanceResult[] {
    return this.rows.filter((r) => !r.reported).map((r) => structuredClone(r.result));
  }
  markReported(instances: readonly string[]): void {
    for (const r of this.rows) if (instances.includes(r.result.instance)) r.reported = true;
  }
}

const DDL = `
CREATE TABLE IF NOT EXISTS instance_results (
  instance TEXT PRIMARY KEY,
  dungeon TEXT NOT NULL,
  entrance TEXT NOT NULL,
  outcome TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  result TEXT NOT NULL,
  granted INTEGER NOT NULL,
  lost INTEGER NOT NULL,
  reported INTEGER NOT NULL DEFAULT 0
);
`;

export class SqliteInstanceResultStore implements InstanceResultStore {
  private readonly db: Database.Database;

  constructor(file: string) {
    const f = path.resolve(file);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    this.db = new Database(f);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(DDL);
  }

  record(r: InstanceResult, granted: number, lost: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO instance_results (instance, dungeon, entrance, outcome, started_at, ended_at, result, granted, lost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(r.instance, r.dungeon, r.entrance, r.outcome, r.startedAt, r.endedAt, JSON.stringify(r), granted, lost);
  }

  unreported(): InstanceResult[] {
    return (this.db.prepare("SELECT result FROM instance_results WHERE reported = 0 ORDER BY ended_at").all() as { result: string }[]).map(
      (r) => JSON.parse(r.result) as InstanceResult,
    );
  }

  markReported(instances: readonly string[]): void {
    const st = this.db.prepare("UPDATE instance_results SET reported = 1 WHERE instance = ?");
    this.db.transaction(() => {
      for (const i of instances) st.run(i);
    })();
  }

  close(): void {
    this.db.close();
  }
}
