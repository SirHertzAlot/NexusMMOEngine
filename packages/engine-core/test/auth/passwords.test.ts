/**
 * Password hashing tests (auth slice).
 *
 * - argon2id round-trips: hash -> verify ok, wrong password rejected.
 * - A malformed stored hash verifies as false (never throws out of auth).
 * - Hashes are salted: the same password hashes differently twice.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
} from "../../src/auth/index.js";

describe("auth: passwords", () => {
  it("hashes and verifies with argon2id", async () => {
    const hash = await hashPassword("correct-horse-123");
    assert.match(hash, /^\$argon2id\$/);
    assert.equal(await verifyPassword(hash, "correct-horse-123"), true);
    assert.equal(await verifyPassword(hash, "wrong-password"), false);
  });

  it("a malformed stored hash verifies as false instead of throwing", async () => {
    assert.equal(await verifyPassword("not-a-hash", "anything"), false);
    assert.equal(await verifyPassword("", "anything"), false);
  });

  it("salts hashes: same password, different hash each time", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    assert.notEqual(a, b);
    assert.equal(await verifyPassword(a, "same-password"), true);
    assert.equal(await verifyPassword(b, "same-password"), true);
  });

  it("DUMMY_HASH is a valid argon2id hash (unknown-user timing ballast)", async () => {
    assert.match(DUMMY_HASH, /^\$argon2id\$/);
    // It verifies *something* — the caller still requires a real record.
    assert.equal(await verifyPassword(DUMMY_HASH, "dummy-placeholder"), true);
    assert.equal(await verifyPassword(DUMMY_HASH, "nope"), false);
  });
});
