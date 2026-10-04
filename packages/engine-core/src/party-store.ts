/**
 * SQLite PartyStore (roadmap S3b): parties survive a server restart.
 *
 * Own database file (./data/parties.db), same pragmas as the guild store.
 * Writes are synchronous write-through, one transaction per call. Invites
 * and online state are not stored.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PartyRecord, PartyStore } from "./party.js";

const DDL = `
CREATE TABLE IF NOT EXISTS parties (
  id INTEGER PRIMARY KEY,
  leader TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS party_members (
  party INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (party, key)
);
`;

export class SqlitePartyStore implements PartyStore {
  private readonly db: Database.Database;
  private readonly save: (p: PartyRecord) => void;

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
    const upsert = this.db.prepare(
      "INSERT INTO parties (id, leader) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET leader = excluded.leader",
    );
    const clear = this.db.prepare("DELETE FROM party_members WHERE party = ?");
    const add = this.db.prepare("INSERT INTO party_members (party, key, name, seq) VALUES (?, ?, ?, ?)");
    this.save = this.db.transaction((p: PartyRecord) => {
      upsert.run(p.id, p.leader);
      clear.run(p.id);
      p.members.forEach((m, i) => add.run(p.id, m.key, m.name, i));
    });
  }

  loadAll(): PartyRecord[] {
    const parties = new Map<number, PartyRecord>();
    for (const r of this.db.prepare("SELECT id, leader FROM parties ORDER BY id").all() as Array<{ id: number; leader: string }>) {
      parties.set(r.id, { ...r, members: [] });
    }
    for (const m of this.db.prepare("SELECT party, key, name FROM party_members ORDER BY party, seq").all() as Array<{
      party: number;
      key: string;
      name: string;
    }>) {
      parties.get(m.party)?.members.push({ key: m.key, name: m.name });
    }
    return [...parties.values()];
  }

  saveParty(p: PartyRecord): void {
    this.save(p);
  }

  deleteParty(id: number): void {
    this.db.prepare("DELETE FROM parties WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }
}
