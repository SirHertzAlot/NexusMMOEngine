/**
 * SQLite-backed session tokens (edge/core split E3): a core restart keeps
 * players' sessions, so the edge's resync finds them and nobody has to log
 * in again. Table `sessions` in the server's world.db.
 *
 * Expiry is unchanged from the in-memory manager (wall-clock ms TTL); the
 * plan's tick-based columns would have changed the policy, which E3 rules
 * out. The character a session entered as is not stored: after a restart
 * the player picks it again.
 */
import Database from "better-sqlite3";
import type { AuthSession, SessionStore } from "./sessions.js";

export class SqliteSessionStore implements SessionStore {
  private readonly db: Database.Database;
  private readonly stmts: {
    load: Database.Statement;
    put: Database.Statement;
    del: Database.Statement;
    expired: Database.Statement;
  };

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      playerId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL
    )`);
    this.stmts = {
      load: this.db.prepare("SELECT token, playerId, expiresAt FROM sessions"),
      put: this.db.prepare("INSERT OR REPLACE INTO sessions (token, playerId, createdAt, expiresAt) VALUES (?, ?, ?, ?)"),
      del: this.db.prepare("DELETE FROM sessions WHERE token = ?"),
      expired: this.db.prepare("DELETE FROM sessions WHERE expiresAt <= ?"),
    };
  }

  load(): AuthSession[] {
    const rows = this.stmts.load.all() as Array<{ token: string; playerId: string; expiresAt: number }>;
    return rows.map((r) => ({ token: r.token, clientId: "", username: r.playerId, expiresAt: r.expiresAt }));
  }

  put(s: AuthSession): void {
    this.stmts.put.run(s.token, s.username, Date.now(), s.expiresAt);
  }

  delete(token: string): void {
    this.stmts.del.run(token);
  }

  deleteExpired(nowMs: number): void {
    this.stmts.expired.run(nowMs);
  }

  close(): void {
    this.db.close();
  }
}
