/**
 * SqliteWalletStore: balances persist across instances (a restart).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteWalletStore } from "../../src/economy/wallet-store.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-test-"));
const file = path.join(dir, "economy.db");

afterEach(() => {
  // Per-test files via fresh temp dirs are overkill; one file suffices —
  // each test uses its own character ids.
});

describe("SqliteWalletStore", () => {
  it("an unknown character loads zero", () => {
    const s = new SqliteWalletStore(file);
    assert.equal(s.load(1001), 0);
    s.close();
  });

  it("save then load round-trips", () => {
    const s = new SqliteWalletStore(file);
    s.save(1002, 750);
    assert.equal(s.load(1002), 750);
    s.save(1002, 1250);
    assert.equal(s.load(1002), 1250, "upsert overwrites");
    s.close();
  });

  it("balances survive a restart", () => {
    const a = new SqliteWalletStore(file);
    a.save(1003, 42);
    a.close();
    const b = new SqliteWalletStore(file);
    assert.equal(b.load(1003), 42);
    b.close();
  });
});
