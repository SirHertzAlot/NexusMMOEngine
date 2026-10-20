/**
 * SQLite GuildStore (roadmap S4b): guilds survive a server restart.
 *
 * Own database file (./data/guilds.db), same pragmas as the character
 * store. Writes are synchronous write-through, one transaction per call.
 * The officer log keeps the newest GUILD_LOG_KEEP lines per guild.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { GUILD_LOG_KEEP, type GuildRank, type GuildRecord, type GuildStore } from "./guild.js";

const DDL = `
CREATE TABLE IF NOT EXISTS guilds (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tag TEXT NOT NULL,
  motd TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guild_members (
  guild INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rank TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (guild, name)
);
CREATE TABLE IF NOT EXISTS guild_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  guild INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS guild_log_by_guild ON guild_log (guild, seq);
`;

export class SqliteGuildStore implements GuildStore {
  private readonly db: Database.Database;
  private readonly save: (g: GuildRecord) => void;

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
      "INSERT INTO guilds (id, name, tag, motd) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET name = excluded.name, tag = excluded.tag, motd = excluded.motd",
    );
    const clear = this.db.prepare("DELETE FROM guild_members WHERE guild = ?");
    const add = this.db.prepare("INSERT INTO guild_members (guild, name, rank, joined_at, seq) VALUES (?, ?, ?, ?, ?)");
    this.save = this.db.transaction((g: GuildRecord) => {
      upsert.run(g.id, g.name, g.tag, g.motd);
      clear.run(g.id);
      g.members.forEach((m, i) => add.run(g.id, m.name, m.rank, m.joinedAt, i));
    });
  }

  loadAll(): ReturnType<GuildStore["loadAll"]> {
    const guilds = new Map<number, GuildRecord>();
    for (const r of this.db.prepare("SELECT id, name, tag, motd FROM guilds ORDER BY id").all() as Array<{
      id: number;
      name: string;
      tag: string;
      motd: string;
    }>) {
      guilds.set(r.id, { ...r, members: [] });
    }
    for (const m of this.db
      .prepare("SELECT guild, name, rank, joined_at FROM guild_members ORDER BY guild, seq")
      .all() as Array<{ guild: number; name: string; rank: string; joined_at: number }>) {
      guilds.get(m.guild)?.members.push({ name: m.name, rank: m.rank as GuildRank, joinedAt: m.joined_at });
    }
    const log = this.db.prepare("SELECT guild, at, text FROM guild_log ORDER BY seq").all() as Array<{
      guild: number;
      at: number;
      text: string;
    }>;
    return { guilds: [...guilds.values()], log };
  }

  saveGuild(g: GuildRecord): void {
    this.save(g);
  }

  deleteGuild(id: number): void {
    this.db.prepare("DELETE FROM guilds WHERE id = ?").run(id);
  }

  appendLog(guild: number, at: number, text: string, keep: number = GUILD_LOG_KEEP): void {
    this.db.prepare("INSERT INTO guild_log (guild, at, text) VALUES (?, ?, ?)").run(guild, at, text);
    this.db
      .prepare(
        "DELETE FROM guild_log WHERE guild = ? AND seq <= " +
          "(SELECT seq FROM guild_log WHERE guild = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)",
      )
      .run(guild, guild, keep);
  }

  close(): void {
    this.db.close();
  }
}
