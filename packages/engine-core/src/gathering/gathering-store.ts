/**
 * SQLite GatheringStore: resource node stocks and materials pouches
 * survive a server restart.
 *
 * Own database file (./data/gathering.db), same pragmas as the wallet
 * store. Writes are synchronous write-through, one upsert per change;
 * reads are lazy (a node on registering, a pouch on first touch).
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GatheringStore } from "./gathering.js";

const DDL = `
CREATE TABLE IF NOT EXISTS resource_nodes (
  node_key TEXT PRIMARY KEY,
  stock INTEGER NOT NULL CHECK (stock >= 0),
  regrow_at INTEGER
);
CREATE TABLE IF NOT EXISTS pouches (
  character_id INTEGER NOT NULL,
  material TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (character_id, material)
);
`;

export class SqliteGatheringStore implements GatheringStore {
  private readonly db: Database.Database;
  private readonly getNode: Database.Statement;
  private readonly putNode: Database.Statement;
  private readonly getPouch: Database.Statement;
  private readonly putPouch: Database.Statement;

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
    this.getNode = this.db.prepare("SELECT stock, regrow_at AS regrowAt FROM resource_nodes WHERE node_key = ?");
    this.putNode = this.db.prepare(
      "INSERT INTO resource_nodes (node_key, stock, regrow_at) VALUES (?, ?, ?) ON CONFLICT(node_key) DO UPDATE SET stock = excluded.stock, regrow_at = excluded.regrow_at",
    );
    this.getPouch = this.db.prepare("SELECT material, count FROM pouches WHERE character_id = ?");
    this.putPouch = this.db.prepare(
      "INSERT INTO pouches (character_id, material, count) VALUES (?, ?, ?) ON CONFLICT(character_id, material) DO UPDATE SET count = excluded.count",
    );
  }

  loadNode(key: string): { stock: number; regrowAt: number | null } | undefined {
    return this.getNode.get(key) as { stock: number; regrowAt: number | null } | undefined;
  }

  saveNode(key: string, stock: number, regrowAt: number | null): void {
    this.putNode.run(key, stock, regrowAt);
  }

  loadPouch(charId: number): Record<string, number> {
    const rows = this.getPouch.all(charId) as Array<{ material: string; count: number }>;
    return Object.fromEntries(rows.map((r) => [r.material, r.count]));
  }

  savePouch(charId: number, material: string, count: number): void {
    this.putPouch.run(charId, material, count);
  }

  /** Close the handle (only when this store opened it). */
  close(): void {
    this.db.close();
  }
}
