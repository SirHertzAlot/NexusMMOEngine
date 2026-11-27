/**
 * SQLite WalletStore (roadmap EC1): gold survives a server restart.
 *
 * Own database file (./data/economy.db), same pragmas as the party and
 * guild stores. Writes are synchronous write-through, one upsert per
 * balance change; reads are lazy (a character's row loads on first touch).
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WalletStore } from "./wallet.js";

const DDL = `
CREATE TABLE IF NOT EXISTS wallets (
  character_id INTEGER PRIMARY KEY,
  gold INTEGER NOT NULL CHECK (gold >= 0)
);
`;

export class SqliteWalletStore implements WalletStore {
  private readonly db: Database.Database;
  private readonly loadStmt: (id: number) => { gold: number } | undefined;
  private readonly saveStmt: (id: number, gold: number) => void;

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
    this.db.pragma("foreign_keys = ON");
    this.db.exec(DDL);
    const get = this.db.prepare("SELECT gold FROM wallets WHERE character_id = ?");
    const upsert = this.db.prepare(
      "INSERT INTO wallets (character_id, gold) VALUES (?, ?) ON CONFLICT(character_id) DO UPDATE SET gold = excluded.gold",
    );
    this.loadStmt = (id: number) => get.get(id) as { gold: number } | undefined;
    this.saveStmt = this.db.transaction((id: number, gold: number) => {
      upsert.run(id, gold);
    }) as (id: number, gold: number) => void;
  }

  load(charId: number): number {
    return this.loadStmt(charId)?.gold ?? 0;
  }

  save(charId: number, gold: number): void {
    this.saveStmt(charId, gold);
  }

  /** Close the handle (only when this store opened it). */
  close(): void {
    this.db.close();
  }
}
