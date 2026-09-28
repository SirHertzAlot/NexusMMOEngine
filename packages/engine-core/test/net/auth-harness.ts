/**
 * Shared auth test harness (auth slice).
 *
 * Builds a temp-dir CsvCredentialStore pre-loaded with test users, all
 * sharing one argon2id hash (hashed once per process — argon2 is slow
 * on purpose). Each gateway under test gets its own store, so tests
 * stay isolated.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CsvCredentialStore, hashPassword } from "../../src/index.js";

/** Meets the Zod minimum (8 chars); never used outside tests. */
export const TEST_PASSWORD = "test-password-123";

export const TEST_USERS = ["alice", "user-a", "user-b", "user-c", "zombie", "idle"];

let cachedHash: string | null = null;

async function testPasswordHash(): Promise<string> {
  if (!cachedHash) cachedHash = await hashPassword(TEST_PASSWORD);
  return cachedHash;
}

/** Fresh temp CSV store with TEST_USERS registered. */
export async function makeCredentialStore(): Promise<CsvCredentialStore> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-auth-"));
  const store = new CsvCredentialStore(path.join(dir, "users.csv"));
  const hash = await testPasswordHash();
  for (const u of TEST_USERS) {
    await store.createUser(u, hash);
  }
  return store;
}
