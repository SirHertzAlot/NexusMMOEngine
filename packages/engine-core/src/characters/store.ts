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
  /** Record a death on the character (rules: recordDeaths). */
  recordDeath?(characterId: number, death: DeathRecord): Promise<void>;
  /** Save the character's position and vitals (synchronous: the save timer and leaving call it). */
  saveState?(characterId: number, state: CharacterState): void;
  /** The last saved state, or null (never saved). */
  loadState?(characterId: number): CharacterState | null;
}

/** Where a character was and how it was, as of its last save (roadmap P2b). */
export interface CharacterState {
  x: number;
  y: number;
  z: number;
  health: number;
  stamina: number;
}

export interface DeathRecord {
  at: number;
  x: number;
  z: number;
  /** The killer's character id, or null (creature, bot, nothing). */
  killer: number | null;
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
CREATE TABLE IF NOT EXISTS deaths (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  x REAL NOT NULL,
  z REAL NOT NULL,
  killer INTEGER
);
CREATE INDEX IF NOT EXISTS idx_deaths_character ON deaths(character_id);
CREATE TABLE IF NOT EXISTS character_state (
  character_id INTEGER PRIMARY KEY,
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,
  health REAL NOT NULL,
  stamina REAL NOT NULL,
  saved_at INTEGER NOT NULL
);
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

  async recordDeath(characterId: number, d: DeathRecord): Promise<void> {
    this.db
      .prepare("INSERT INTO deaths (character_id, at, x, z, killer) VALUES (?, ?, ?, ?, ?)")
      .run(characterId, d.at, d.x, d.z, d.killer);
  }

  saveState(characterId: number, st: CharacterState): void {
    this.db
      .prepare(
        "INSERT INTO character_state (character_id, x, y, z, health, stamina, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(character_id) DO UPDATE SET x = excluded.x, y = excluded.y, z = excluded.z, health = excluded.health, stamina = excluded.stamina, saved_at = excluded.saved_at",
      )
      .run(characterId, st.x, st.y, st.z, st.health, st.stamina, this.clock());
  }

  loadState(characterId: number): CharacterState | null {
    const r = this.db
      .prepare("SELECT x, y, z, health, stamina FROM character_state WHERE character_id = ?")
      .get(characterId) as CharacterState | undefined;
    return r ?? null;
  }

  close(): void {
    this.db.close();
  }
}

export class MemoryCharacterStore implements CharacterStore {
  private readonly rows: CharacterRecord[] = [];
  private nextId = 1;

  /** Deaths recorded, oldest first. */
  readonly deaths: (DeathRecord & { characterId: number })[] = [];

  constructor(private readonly clock: () => number = Date.now) {}

  async recordDeath(characterId: number, d: DeathRecord): Promise<void> {
    this.deaths.push({ characterId, ...d });
  }

  private readonly states = new Map<number, CharacterState>();

  saveState(characterId: number, st: CharacterState): void {
    this.states.set(characterId, { ...st });
  }

  loadState(characterId: number): CharacterState | null {
    const st = this.states.get(characterId);
    return st ? { ...st } : null;
  }

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
