/**
 * SessionManager tests (auth slice).
 *
 * - create() issues unique 64-hex tokens bound to (clientId, username).
 * - get() returns live sessions; unknown tokens return null.
 * - Expiry is lazy on get() and eager in sweep(), driven by an
 *   injectable clock — no real waiting in tests.
 * - revoke() kills a token immediately; rebind() tracks reconnects.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/auth/index.js";

describe("auth: SessionManager", () => {
  it("issues unique opaque tokens", () => {
    const sm = new SessionManager();
    const a = sm.create("c1", "alice");
    const b = sm.create("c2", "bob");
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.match(b, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
    assert.equal(sm.size(), 2);
  });

  it("get() returns the session, unknown tokens return null", () => {
    const sm = new SessionManager();
    const tok = sm.create("c1", "alice");
    const s = sm.get(tok);
    assert(s, "session found");
    assert.equal(s.username, "alice");
    assert.equal(s.clientId, "c1");
    assert.equal(s.token, tok);
    assert.equal(sm.get("0".repeat(64)), null, "unknown token -> null");
  });

  it("sessions expire after the TTL (lazy on get)", () => {
    let now = 1_000_000;
    const sm = new SessionManager({ ttlMs: 1000, clock: () => now });
    const tok = sm.create("c1", "alice");
    now += 999;
    assert(sm.get(tok), "still alive just before TTL");
    now += 2;
    assert.equal(sm.get(tok), null, "expired -> null");
    assert.equal(sm.size(), 0, "expired entry removed eagerly");
  });

  it("sweep() removes expired sessions and reports the count", () => {
    let now = 1_000_000;
    const sm = new SessionManager({ ttlMs: 1000, clock: () => now });
    const a = sm.create("c1", "alice");
    const b = sm.create("c2", "bob");
    now += 500;
    const c = sm.create("c3", "carol");
    now += 600; // a and b expired, c alive
    assert.equal(sm.sweep(), 2);
    assert.equal(sm.get(a), null);
    assert.equal(sm.get(b), null);
    assert(sm.get(c), "c still alive");
  });

  it("revoke() kills a token immediately", () => {
    const sm = new SessionManager();
    const tok = sm.create("c1", "alice");
    sm.revoke(tok);
    assert.equal(sm.get(tok), null);
  });

  it("rebind() tracks the current connection for a token", () => {
    const sm = new SessionManager();
    const tok = sm.create("c1", "alice");
    sm.rebind(tok, "c2");
    assert.equal(sm.get(tok)!.clientId, "c2");
  });

  it("rejects a non-positive TTL", () => {
    assert.throws(() => new SessionManager({ ttlMs: 0 }), /ttlMs/);
    assert.throws(() => new SessionManager({ ttlMs: -5 }), /ttlMs/);
  });
});
