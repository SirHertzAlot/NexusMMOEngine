/**
 * Zod hello-schema tests (auth slice).
 *
 * Zod is input validation, not authentication: these schemas accept or
 * reject shapes before any credential logic runs. Malformed payloads
 * (both/neither variant, bad lengths, unknown fields) must all fail.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AdminCommandSchema, parseHello } from "../../src/auth/index.js";

const base = { protocol: 2, client: "test-client", want_snapshot: true };

describe("auth: hello schemas", () => {
  it("accepts the credentials variant", () => {
    const r = parseHello({ ...base, username: "alice_1", password: "s3cret!!" });
    assert(r, "parses");
    assert.equal(r.kind, "credentials");
    if (r.kind === "credentials") {
      assert.equal(r.value.username, "alice_1");
    }
  });

  it("accepts the token variant", () => {
    const token = "a".repeat(64);
    const r = parseHello({ ...base, token });
    assert(r, "parses");
    assert.equal(r.kind, "token");
  });

  it("accepts the migration variant (arriving from another region)", () => {
    const r = parseHello({ ...base, migration: "mig-" + "0a".repeat(12), ticket: "f".repeat(64) });
    assert(r, "parses");
    assert.equal(r.kind, "migration");
    assert.equal(parseHello({ ...base, migration: "mig-xyz", ticket: "f".repeat(64) }), null, "bad migration id");
    assert.equal(parseHello({ ...base, migration: "mig-" + "0a".repeat(12), ticket: "short" }), null, "bad ticket");
    assert.equal(
      parseHello({ ...base, migration: "mig-" + "0a".repeat(12), ticket: "f".repeat(64), token: "a".repeat(64) }),
      null,
      "migration plus token -> malformed",
    );
  });

  it("rejects payloads carrying both or neither variant", () => {
    assert.equal(
      parseHello({ ...base, username: "alice", password: "s3cret!!", token: "a".repeat(64) }),
      null,
      "both variants -> malformed",
    );
    assert.equal(parseHello({ ...base }), null, "neither variant -> malformed");
  });

  it("rejects bad lengths and formats", () => {
    // Username too short / with illegal chars.
    assert.equal(parseHello({ ...base, username: "ab", password: "s3cret!!" }), null);
    assert.equal(parseHello({ ...base, username: "has space", password: "s3cret!!" }), null);
    // Password too short.
    assert.equal(parseHello({ ...base, username: "alice", password: "short" }), null);
    // Token not 64 hex chars.
    assert.equal(parseHello({ ...base, token: "tok-alice" }), null);
    assert.equal(parseHello({ ...base, token: "Z".repeat(64) }), null);
    // Base fields.
    assert.equal(parseHello({ ...base, client: "", username: "alice", password: "s3cret!!" }), null);
    assert.equal(parseHello({ ...base, protocol: 2.5, username: "alice", password: "s3cret!!" }), null);
  });

  it("rejects unknown fields (strict mode)", () => {
    assert.equal(
      parseHello({ ...base, username: "alice", password: "s3cret!!", admin: true }),
      null,
      "extra fields are not smuggled past validation",
    );
  });

  it("rejects non-objects", () => {
    assert.equal(parseHello(null), null);
    assert.equal(parseHello("hello"), null);
    assert.equal(parseHello(42), null);
  });
});

describe("auth: admin command schema", () => {
  it("accepts kind + lowercase command, with optional args", () => {
    const help = AdminCommandSchema.safeParse({ kind: "admin", command: "help" });
    assert.equal(help.success, true);
    const withArgs = AdminCommandSchema.safeParse({ kind: "admin", command: "spawn", args: { what: "tree" } });
    assert.equal(withArgs.success, true);
  });

  it("rejects wrong kind, bad names, and extra fields", () => {
    assert.equal(AdminCommandSchema.safeParse({ kind: "debug", command: "help" }).success, false);
    assert.equal(AdminCommandSchema.safeParse({ kind: "admin", command: "Help" }).success, false);
    assert.equal(AdminCommandSchema.safeParse({ kind: "admin", command: "a b" }).success, false);
    assert.equal(AdminCommandSchema.safeParse({ kind: "admin" }).success, false);
    assert.equal(AdminCommandSchema.safeParse({ kind: "admin", command: "help", admin: true }).success, false);
  });
});
