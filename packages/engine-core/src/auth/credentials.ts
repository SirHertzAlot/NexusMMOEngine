/**
 * CredentialStore — the account lookup boundary (auth slice, 2026-09-27).
 *
 * SOLID: the gateway depends on this narrow interface, not on any
 * storage. The dev-phase implementation is a CSV file; accounts move to
 * SQLite (or another store) later behind the same interface, with no
 * gateway changes.
 *
 * Async by design: file (now) and database (later) implementations both
 * fit without changing callers.
 *
 * Security invariants (enforced here, not left to callers):
 * - Only password HASHES are stored. Plaintext passwords never reach this
 *   module — hash them with ./passwords.ts first.
 * - Usernames are restricted to [A-Za-z0-9_-]{3,32} so they are safe to
 *   interpolate into logs and can never collide with CSV syntax.
 * - Both fields are double-quoted on write and parsed quote-aware on
 *   read: argon2's own parameter section (`m=65536,p=4,t=3`) contains
 *   commas, so plain concatenation would corrupt real hashes.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface CredentialRecord {
  username: string;
  /** argon2id hash (modular crypt format). Never a plaintext password. */
  passwordHash: string;
}

export interface CredentialStore {
  /** Null when the username is unknown. */
  findUser(username: string): Promise<CredentialRecord | null>;
  /** Throws when the username already exists or the input is invalid. */
  createUser(username: string, passwordHash: string): Promise<void>;
}

/** Usernames must match this (also enforced by the Zod hello schema). */
export const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

/** Default CSV path, relative to the process working directory. */
export const DEFAULT_USERS_CSV_PATH = "./data/users.csv";

function assertValidUsername(username: string): void {
  if (!USERNAME_RE.test(username)) {
    throw new Error(
      `credential-store: invalid username ${JSON.stringify(username)} ` +
        `(want ${USERNAME_RE})`,
    );
  }
}

function assertValidHash(passwordHash: string): void {
  // Commas are legal (argon2's parameter section uses them) because
  // fields are quoted on write and parsed quote-aware on read. Quotes
  // and newlines are not, and would break the row encoding.
  if (
    typeof passwordHash !== "string" ||
    passwordHash.length === 0 ||
    passwordHash.length > 512 ||
    /[\r\n"]/.test(passwordHash)
  ) {
    throw new Error("credential-store: invalid password hash");
  }
}

/**
 * Minimal quote-aware CSV row parser: exactly two fields, each either
 * bare or double-quoted. Throws on malformed rows. Only `""` inside a
 * quoted field is unescaped (we never write quotes, so this is a
 * read-tolerance path).
 */
function parseRow(line: string): [string, string] {
  const fields: string[] = [];
  let i = 0;
  while (true) {
    let field = "";
    if (line[i] === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        field += line[i];
        i++;
      }
      if (line[i] !== '"') {
        throw new Error("malformed row: unterminated quote");
      }
      i++;
      // Tolerate "" as an escaped quote (never written by us).
      field = field.replace(/""/g, '"');
    } else {
      while (i < line.length && line[i] !== ",") {
        field += line[i];
        i++;
      }
    }
    fields.push(field);
    if (i >= line.length) break;
    if (line[i] !== ",") throw new Error("malformed row: expected comma");
    i++;
  }
  if (fields.length !== 2) {
    throw new Error(`malformed row: want 2 fields, got ${fields.length}`);
  }
  return [fields[0], fields[1]];
}

/** Quote a field for the CSV row encoding. */
function quote(field: string): string {
  if (/["\r\n]/.test(field)) {
    throw new Error("credential-store: field cannot be quoted safely");
  }
  return `"${field}"`;
}

/**
 * CSV-backed CredentialStore: one `"username","hash"` row per line.
 *
 * Fields are double-quoted because real argon2 hashes contain commas
 * (`$argon2id$v=19$m=65536,p=4,t=3$...`); rows are parsed quote-aware.
 *
 * Single-writer assumption: the authoritative server is one process
 * (architecture brief §1), so the file is loaded once and kept in
 * memory; createUser appends atomically-ish (single append write) and
 * updates the cache. External edits while running are NOT picked up —
 * restart to reload.
 */
export class CsvCredentialStore implements CredentialStore {
  readonly path: string;
  private readonly users = new Map<string, string>();

  constructor(csvPath: string = DEFAULT_USERS_CSV_PATH) {
    this.path = path.resolve(csvPath);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    if (!fs.existsSync(this.path)) {
      fs.writeFileSync(this.path, "", { mode: 0o600 });
    }
    // Enforce 0600 regardless of umask or pre-existing permissions:
    // credential files must never be group/world-readable.
    fs.chmodSync(this.path, 0o600);
    this.load();
  }

  async findUser(username: string): Promise<CredentialRecord | null> {
    const passwordHash = this.users.get(username);
    return passwordHash === undefined
      ? null
      : { username, passwordHash };
  }

  async createUser(username: string, passwordHash: string): Promise<void> {
    assertValidUsername(username);
    assertValidHash(passwordHash);
    if (this.users.has(username)) {
      throw new Error(
        `credential-store: user ${JSON.stringify(username)} already exists`,
      );
    }
    // Both fields are quoted: real argon2 hashes contain commas.
    fs.appendFileSync(this.path, `${quote(username)},${quote(passwordHash)}\n`, {
      mode: 0o600,
    });
    this.users.set(username, passwordHash);
  }

  /** Number of loaded accounts (diagnostic). */
  size(): number {
    return this.users.size;
  }

  private load(): void {
    const text = fs.readFileSync(this.path, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let username: string;
      let passwordHash: string;
      try {
        [username, passwordHash] = parseRow(line);
      } catch (err) {
        throw new Error(
          `credential-store: malformed row in ${this.path} (${err instanceof Error ? err.message : err})`,
        );
      }
      assertValidUsername(username);
      assertValidHash(passwordHash);
      if (this.users.has(username)) {
        throw new Error(
          `credential-store: duplicate user ${JSON.stringify(username)} in ${this.path}`,
        );
      }
      this.users.set(username, passwordHash);
    }
  }
}
