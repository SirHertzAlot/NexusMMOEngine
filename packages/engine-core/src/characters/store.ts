/**
 * CharacterStore — an account's characters (name + look), the boundary
 * the gateway depends on (like CredentialStore for accounts).
 *
 * Looks are stored as canonical JSON (@mmo-engine/art lookToJson),
 * already validated by the caller. Names are unique on the server,
 * ignoring case. Limits (characters per account) are enforced here, in
 * the same transaction as the insert, so two creates can't both slip
 * under the limit.
 *
 * SqliteCharacterStore is the real one (./data/characters.db);
 * MemoryCharacterStore serves tests and servers without persistence.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

export interface CharacterRecord {
  id: number;
  username: string;
  name: string;
  /** Canonical look JSON. */
  look: string;
  createdAt: number;
}

/** Why a create was refused (the request was well-formed). */
export type CharacterRefusal = "name-taken" | "limit";

export class CharacterRefusedError extends Error {
  constructor(readonly reason: CharacterRefusal) {
    super(reason === "name-taken" ? "that name is taken" : "this account has all the characters it may have");
    this.name = "CharacterRefusedError";
  }
}

export interface CharacterStore {
  /** The account's characters, oldest first. */
  list(username: string): Promise<CharacterRecord[]>;
  /** One of the account's characters, or null (unknown, or someone else's). */
  get(username: string, id: number): Promise<CharacterRecord | null>;
  /** Throws CharacterRefusedError when the name is taken or the account is full. */
  create(username: string, name: string, look: string, maxPerAccount: number): Promise<CharacterRecord>;
}

export const DEFAULT_CHARACTERS_DB_PATH = "./data/characters.db";

const DDL = `
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  look TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_characters_username ON characters(username);
`;

interface Row {
  id: number;
  username: string;
  name: string;
  look: string;
  created_at: number;
}

const toRecord = (r: Row): CharacterRecord => ({
  id: r.id,
  username: r.username,
  name: r.name,
  look: r.look,
  createdAt: r.created_at,
});

/** The uniqueness key of a name: names differ by more than case. */
export const nameKey = (name: string): string => name.toLowerCase();

export class SqliteCharacterStore implements CharacterStore {
  private readonly db: Database.Database;
  private readonly insert: (username: string, name: string, look: string, max: number) => CharacterRecord;

  constructor(dbPath: string = DEFAULT_CHARACTERS_DB_PATH, private readonly clock: () => number = Date.now) {
    const file = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(DDL);
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM characters WHERE username = ?");
    const taken = this.db.prepare("SELECT 1 FROM characters WHERE name_key = ?");
    const add = this.db.prepare(
      "INSERT INTO characters (username, name, name_key, look, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.insert = this.db.transaction((username: string, name: string, look: string, max: number) => {
      if ((count.get(username) as { n: number }).n >= max) throw new CharacterRefusedError("limit");
      if (taken.get(nameKey(name))) throw new CharacterRefusedError("name-taken");
      const createdAt = this.clock();
      const id = Number(add.run(username, name, nameKey(name), look, createdAt).lastInsertRowid);
      return { id, username, name, look, createdAt };
    });
  }

  async list(username: string): Promise<CharacterRecord[]> {
    const rows = this.db
      .prepare("SELECT id, username, name, look, created_at FROM characters WHERE username = ? ORDER BY id")
      .all(username) as Row[];
    return rows.map(toRecord);
  }

  async get(username: string, id: number): Promise<CharacterRecord | null> {
    const row = this.db
      .prepare("SELECT id, username, name, look, created_at FROM characters WHERE id = ? AND username = ?")
      .get(id, username) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  async create(username: string, name: string, look: string, maxPerAccount: number): Promise<CharacterRecord> {
    return this.insert(username, name, look, maxPerAccount);
  }

  close(): void {
    this.db.close();
  }
}

export class MemoryCharacterStore implements CharacterStore {
  private readonly rows: CharacterRecord[] = [];
  private nextId = 1;

  constructor(private readonly clock: () => number = Date.now) {}

  async list(username: string): Promise<CharacterRecord[]> {
    return this.rows.filter((r) => r.username === username).map((r) => ({ ...r }));
  }

  async get(username: string, id: number): Promise<CharacterRecord | null> {
    const r = this.rows.find((c) => c.id === id && c.username === username);
    return r ? { ...r } : null;
  }

  async create(username: string, name: string, look: string, maxPerAccount: number): Promise<CharacterRecord> {
    if (this.rows.filter((r) => r.username === username).length >= maxPerAccount) throw new CharacterRefusedError("limit");
    if (this.rows.some((r) => nameKey(r.name) === nameKey(name))) throw new CharacterRefusedError("name-taken");
    const record = { id: this.nextId++, username, name, look, createdAt: this.clock() };
    this.rows.push(record);
    return { ...record };
  }
}
