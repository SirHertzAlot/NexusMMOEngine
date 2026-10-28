/**
 * Place records (IX5): what players changed in the world that the ECS snapshot does not keep,
 * because scenes spawn again on every boot: a prop that broke (and when it comes back), a chest
 * that was opened (and when it refills), a door left open. One row per thing, keyed by scene and
 * node id (`places/P0001`) like resource node stocks are.
 *
 * Own database file (./data/places.db), same pragmas as the gathering store. Writes are
 * synchronous write-through. The rows ride the range snapshot as `places.place_records`
 * and are seeded back on recall, so a region that moves hosts keeps them.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

const DDL = `
CREATE TABLE IF NOT EXISTS place_records (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL,
  at INTEGER NOT NULL,
  respawn_at INTEGER,
  PRIMARY KEY (kind, key)
);
`;

/** "break": a breakable prop (state "broken"); "chest": a chest or door (state "open"); "resident": a townsperson (state "dead:<n>" until replaced, then "alive:<n>"). */
export type PlaceKind = "break" | "chest" | "resident";

export interface PlaceRecord {
  kind: PlaceKind;
  key: string;
  state: string;
  /** When it changed, unix ms. */
  at: number;
  /** When it goes back (unix ms); null: it stays this way. */
  respawnAt: number | null;
}

/** What BreakSystem and ChestSystem need of a store; SqlitePlacesStore is the real one. */
export interface PlacesStore {
  load(kind: PlaceKind, key: string): PlaceRecord | undefined;
  save(rec: PlaceRecord): void;
  clear(kind: PlaceKind, key: string): void;
  /** Every record (the world's scatter props that broke are found again after a restart). */
  all?(): PlaceRecord[];
}

/** The records in a world snapshot's `places.place_records`; rows that aren't one are dropped. */
export function placeRecordsOf(v: unknown): PlaceRecord[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (r): r is PlaceRecord =>
      typeof r === "object" && r !== null &&
      (r.kind === "break" || r.kind === "chest" || r.kind === "resident") &&
      typeof r.key === "string" && typeof r.state === "string" &&
      Number.isFinite(r.at) && (r.respawnAt === null || Number.isFinite(r.respawnAt)),
  );
}

export class SqlitePlacesStore implements PlacesStore {
  private readonly db: Database.Database;
  private readonly getRow: Database.Statement;
  private readonly putRow: Database.Statement;
  private readonly delRow: Database.Statement;

  /** `target` is a file path, or an open handle (shared with another store). */
  constructor(target: string | Database.Database) {
    if (typeof target === "string") {
      const file = path.resolve(target);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.db = new Database(file);
      this.db.pragma("journal_mode = WAL");
    } else {
      this.db = target;
    }
    this.db.exec(DDL);
    this.getRow = this.db.prepare("SELECT kind, key, state, at, respawn_at AS respawnAt FROM place_records WHERE kind = ? AND key = ?");
    this.putRow = this.db.prepare(
      "INSERT INTO place_records (kind, key, state, at, respawn_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET state = excluded.state, at = excluded.at, respawn_at = excluded.respawn_at",
    );
    this.delRow = this.db.prepare("DELETE FROM place_records WHERE kind = ? AND key = ?");
  }

  load(kind: PlaceKind, key: string): PlaceRecord | undefined {
    return this.getRow.get(kind, key) as PlaceRecord | undefined;
  }

  save(r: PlaceRecord): void {
    this.putRow.run(r.kind, r.key, r.state, r.at, r.respawnAt);
  }

  clear(kind: PlaceKind, key: string): void {
    this.delRow.run(kind, key);
  }

  /** Every record, for the range snapshot. */
  all(): PlaceRecord[] {
    return this.db.prepare("SELECT kind, key, state, at, respawn_at AS respawnAt FROM place_records ORDER BY kind, key").all() as PlaceRecord[];
  }

  /** Replace every record with the world's copy (recall), in one transaction. */
  replaceAll(rows: readonly PlaceRecord[]): void {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM place_records");
      for (const r of rows) this.save(r);
    })();
  }

  close(): void {
    this.db.close();
  }
}
