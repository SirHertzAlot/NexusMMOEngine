/**
 * SQLite FriendStore (roadmap S2c): friends lists survive a server restart.
 *
 * Own database file (./data/friends.db), same pragmas as the guild store.
 * Writes are synchronous write-through, one statement per call.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FriendStore } from "./friends.js";

const DDL = `
CREATE TABLE IF NOT EXISTS friends (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  friend TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (owner, friend)
);
`;

export class SqliteFriendStore implements FriendStore {
  private readonly db: Database.Database;
  private readonly insert: Database.Statement;
  private readonly del: Database.Statement;
  private readonly all: Database.Statement;

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
    this.insert = this.db.prepare("INSERT OR IGNORE INTO friends (owner, friend, name) VALUES (?, ?, ?)");
    this.del = this.db.prepare("DELETE FROM friends WHERE owner = ? AND friend = ?");
    this.all = this.db.prepare("SELECT owner, name FROM friends ORDER BY seq");
  }

  loadAll(): Array<{ owner: string; friends: string[] }> {
    const by = new Map<string, string[]>();
    for (const r of this.all.all() as Array<{ owner: string; name: string }>) {
      let l = by.get(r.owner);
      if (!l) by.set(r.owner, (l = []));
      l.push(r.name);
    }
    return [...by].map(([owner, friends]) => ({ owner, friends }));
  }

  add(owner: string, friend: string): void {
    this.insert.run(owner.toLowerCase(), friend.toLowerCase(), friend);
  }

  remove(owner: string, friend: string): void {
    this.del.run(owner.toLowerCase(), friend.toLowerCase());
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
