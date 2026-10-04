/**
 * SQLite QuestStore (roadmap P1): quest logs survive a restart.
 *
 * Own database file (./data/quests.db), WAL like the other stores. A row is
 * one quest in one character's log, its record as JSON: a generated quest's
 * definition is kept whole, so it stays what was offered even if the content
 * it was generated from changes.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import type { QuestRecord, QuestStore } from "./quest-log.js";

const DDL = `
CREATE TABLE IF NOT EXISTS quest_log (
  character_id INTEGER NOT NULL,
  quest_id TEXT NOT NULL,
  record TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (character_id, quest_id)
);
`;

export class SqliteQuestStore implements QuestStore {
  private readonly db: Database.Database;
  private readonly upsert: Database.Statement;
  private readonly del: Database.Statement;
  private readonly select: Database.Statement;

  constructor(file: string) {
    const f = path.resolve(file);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    this.db = new Database(f);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(DDL);
    this.upsert = this.db.prepare(
      "INSERT INTO quest_log (character_id, quest_id, record, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(character_id, quest_id) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at",
    );
    this.del = this.db.prepare("DELETE FROM quest_log WHERE character_id = ? AND quest_id = ?");
    this.select = this.db.prepare("SELECT record FROM quest_log WHERE character_id = ?");
  }

  load(characterId: number): QuestRecord[] {
    return (this.select.all(characterId) as Array<{ record: string }>).map((r) => JSON.parse(r.record) as QuestRecord);
  }

  save(characterId: number, record: QuestRecord): void {
    this.upsert.run(characterId, record.def.id, JSON.stringify(record), Date.now());
  }

  remove(characterId: number, questId: string): void {
    this.del.run(characterId, questId);
  }

  close(): void {
    this.db.close();
  }
}
