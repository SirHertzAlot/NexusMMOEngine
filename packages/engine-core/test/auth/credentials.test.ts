/**
 * CsvCredentialStore tests (auth slice).
 *
 * - Round-trip: createUser -> findUser returns the record.
 * - Duplicate usernames are rejected; unknown users return null.
 * - The CSV file is created with mode 0600, and pre-existing files with
 *   looser permissions are tightened to 0600 on open.
 * - Invalid usernames / hashes are rejected before touching the file.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CsvCredentialStore,
  hashPassword,
} from "../../src/auth/index.js";

const HASH =
  "$argon2id$v=19$m=65536,p=4,t=3$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function tempCsv(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mmo-creds-")), "users.csv");
}

function modeOf(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

// Windows has no POSIX permission bits (files always read back 0o666);
// owner-only access there comes from the profile directory ACLs.
const POSIX_ONLY = process.platform === "win32" ? "POSIX permissions do not exist on Windows" : false;

describe("auth: CsvCredentialStore", () => {
  it("round-trips a user", async () => {
    const store = new CsvCredentialStore(tempCsv());
    assert.equal(await store.findUser("alice"), null);
    await store.createUser("alice", HASH);
    const rec = await store.findUser("alice");
    assert(rec, "user found after create");
    assert.equal(rec.username, "alice");
    assert.equal(rec.passwordHash, HASH);
    assert.equal(store.size(), 1);
  });

  it("rejects duplicate usernames", async () => {
    const store = new CsvCredentialStore(tempCsv());
    await store.createUser("bob", HASH);
    await assert.rejects(store.createUser("bob", HASH), /already exists/);
  });

  it("creates the file with mode 0600", { skip: POSIX_ONLY }, async () => {
    const p = tempCsv();
    new CsvCredentialStore(p);
    assert.equal(modeOf(p), 0o600, "credential file must be owner-only");
  });

  it("tightens pre-existing loose permissions to 0600", { skip: POSIX_ONLY }, async () => {
    const p = tempCsv();
    fs.writeFileSync(p, "");
    fs.chmodSync(p, 0o644);
    assert.equal(modeOf(p), 0o644);
    new CsvCredentialStore(p);
    assert.equal(modeOf(p), 0o600, "loose permissions are fixed on open");
  });

  it("rejects invalid usernames and hashes", async () => {
    const store = new CsvCredentialStore(tempCsv());
    await assert.rejects(store.createUser("has space", HASH), /invalid username/);
    await assert.rejects(store.createUser("a,b", HASH), /invalid username/);
    await assert.rejects(store.createUser("ab", HASH), /invalid username/);
    await assert.rejects(store.createUser("alice", ""), /invalid password hash/);
    await assert.rejects(
      store.createUser("alice", 'hash"with"quotes'),
      /invalid password hash/,
    );
    await assert.rejects(
      store.createUser("alice", "hash\nwith\nnewlines"),
      /invalid password hash/,
    );
    assert.equal(store.size(), 0, "nothing was written");
  });

  it("round-trips hashes containing commas (argon2 param section)", async () => {
    // Regression: real argon2 hashes look like
    // $argon2id$v=19$m=65536,p=4,t=3$... — the commas must survive the CSV.
    const p = tempCsv();
    const s1 = new CsvCredentialStore(p);
    await s1.createUser("comma-user", HASH);
    const raw = fs.readFileSync(p, "utf8").trim();
    assert.match(raw, /^"comma-user","\$argon2id\$/, "fields are quoted");
    const s2 = new CsvCredentialStore(p);
    const rec = await s2.findUser("comma-user");
    assert(rec, "user survives reopen");
    assert.equal(rec.passwordHash, HASH, "hash bit-identical after quoting");
  });

  it("rejects a malformed CSV row on load", async () => {
    const p = tempCsv();
    fs.writeFileSync(p, "no-comma-here\n");
    assert.throws(() => new CsvCredentialStore(p), /malformed row/);
  });

  it("persists across reopen (single-writer reload)", async () => {
    const p = tempCsv();
    const real = await hashPassword("s3cret!!");
    const s1 = new CsvCredentialStore(p);
    await s1.createUser("carol", real);
    const s2 = new CsvCredentialStore(p);
    const rec = await s2.findUser("carol");
    assert(rec, "user survives reopen");
    assert.equal(rec.passwordHash, real);
  });
});
