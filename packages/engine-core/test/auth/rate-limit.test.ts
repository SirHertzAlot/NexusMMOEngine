/**
 * AuthRateLimiter tests (auth slice).
 *
 * - N failures inside the window trip the limiter; the Nth failure does
 *   NOT yet limit (budget is `maxFailures`).
 * - A success clears the IP's failure record.
 * - Failures slide out of the window with the injectable clock.
 * - IPs are tracked independently.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AuthRateLimiter } from "../../src/auth/index.js";

describe("auth: AuthRateLimiter", () => {
  it("trips after maxFailures failures inside the window", () => {
    const rl = new AuthRateLimiter({ maxFailures: 3, windowMs: 60_000 });
    assert.equal(rl.isLimited("1.2.3.4"), false);
    rl.recordFailure("1.2.3.4");
    rl.recordFailure("1.2.3.4");
    assert.equal(rl.isLimited("1.2.3.4"), false, "2 < 3: not limited");
    rl.recordFailure("1.2.3.4");
    assert.equal(rl.isLimited("1.2.3.4"), true, "3 failures: limited");
  });

  it("a success clears the failure record", () => {
    const rl = new AuthRateLimiter({ maxFailures: 2, windowMs: 60_000 });
    rl.recordFailure("1.2.3.4");
    rl.recordFailure("1.2.3.4");
    assert.equal(rl.isLimited("1.2.3.4"), true);
    rl.recordSuccess("1.2.3.4");
    assert.equal(rl.isLimited("1.2.3.4"), false);
  });

  it("failures slide out of the window", () => {
    let now = 1_000_000;
    const rl = new AuthRateLimiter({
      maxFailures: 2,
      windowMs: 1000,
      clock: () => now,
    });
    rl.recordFailure("1.2.3.4");
    rl.recordFailure("1.2.3.4");
    assert.equal(rl.isLimited("1.2.3.4"), true);
    now += 1001;
    assert.equal(rl.isLimited("1.2.3.4"), false, "window slid past failures");
  });

  it("tracks IPs independently", () => {
    const rl = new AuthRateLimiter({ maxFailures: 1, windowMs: 60_000 });
    rl.recordFailure("1.2.3.4");
    assert.equal(rl.isLimited("1.2.3.4"), true);
    assert.equal(rl.isLimited("5.6.7.8"), false);
  });

  it("rejects invalid options", () => {
    assert.throws(() => new AuthRateLimiter({ maxFailures: 0 }), /maxFailures/);
    assert.throws(() => new AuthRateLimiter({ windowMs: -1 }), /windowMs/);
  });
});
