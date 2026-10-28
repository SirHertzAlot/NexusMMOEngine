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

/** One node's saved stock (regrowAt: unix ms, null when none is due). */
export interface NodeStock {
  key: string;
  stock: number;
  regrowAt: number | null;
}

/** The node stocks in a world snapshot's `places.resource_nodes`; rows that aren't one are dropped. */
export function nodeStocksOf(v: unknown): NodeStock[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (r): r is NodeStock =>
      typeof r === "object" && r !== null &&
      typeof r.key === "string" &&
      Number.isInteger(r.stock) && r.stock >= 0 &&
      (r.regrowAt === null || Number.isFinite(r.regrowAt)),
  );
}

/** The pouch in a world character record's `extras.pouch`: material -> whole count >= 0; other entries dropped. */
export function materialCountsOf(v: unknown): Record<string, number> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([, n]) => Number.isInteger(n) && (n as number) >= 0)) as Record<string, number>;
}

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

  /** Every node's stock, for the range snapshot (PL3a: node stocks are the range's, held by the world). */
  allNodes(): NodeStock[] {
    return this.db.prepare("SELECT node_key AS key, stock, regrow_at AS regrowAt FROM resource_nodes ORDER BY node_key").all() as NodeStock[];
  }

  /** Replace every node's stock with the world's copy (recall), in one transaction. */
  replaceNodes(rows: readonly NodeStock[]): void {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM resource_nodes");
      for (const r of rows) this.putNode.run(r.key, r.stock, r.regrowAt);
    })();
  }

  loadPouch(charId: number): Record<string, number> {
    const rows = this.getPouch.all(charId) as Array<{ material: string; count: number }>;
    return Object.fromEntries(rows.map((r) => [r.material, r.count]));
  }

  savePouch(charId: number, material: string, count: number): void {
    this.putPouch.run(charId, material, count);
  }

  /** Replace a character's whole pouch with the world's copy (PL3b), in one transaction. */
  replacePouch(charId: number, pouch: Record<string, number>): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM pouches WHERE character_id = ?").run(charId);
      for (const [material, count] of Object.entries(pouch)) this.putPouch.run(charId, material, count);
    })();
  }

  /** Close the handle (only when this store opened it). */
  close(): void {
    this.db.close();
  }
}
