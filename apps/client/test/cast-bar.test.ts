/**
 * CastBar: which spell messages start and end the player's cast, and how far it is.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SpellMessage } from "@mmo-engine/protocol";
import { castFraction, nextCast } from "../src/ui/cast-bar.js";

const spell = (state: SpellMessage["state"], caster = "7", seconds?: number): SpellMessage => ({
  kind: "spell",
  caster,
  target: "7",
  spell: "mend",
  state,
  ...(seconds !== undefined ? { seconds } : {}),
});

describe("nextCast", () => {
  it("starts on the player's own cast and ends when it is done or stopped", () => {
    const c = nextCast(null, spell("started", "7", 2), "7", 1000);
    assert.deepEqual(c, { spell: "mend", startedAt: 1000, seconds: 2 });
    assert.equal(nextCast(c, spell("done"), "7", 3000), null);
    assert.equal(nextCast(c, spell("stopped"), "7", 1500), null);
  });

  it("ignores someone else's cast", () => {
    const c = nextCast(null, spell("started", "7", 2), "7", 0);
    assert.equal(nextCast(c, spell("done", "9"), "7", 100), c);
    assert.equal(nextCast(null, spell("started", "9", 2), "7", 0), null);
    assert.equal(nextCast(null, spell("started", "7", 2), null, 0), null);
  });

  it("shows no bar for an instant cast", () => {
    assert.equal(nextCast(null, spell("started", "7"), "7", 0), null);
  });
});

describe("castFraction", () => {
  it("fills over the cast time and stops full", () => {
    const c = { spell: "mend", startedAt: 1000, seconds: 2 };
    assert.equal(castFraction(c, 1000), 0);
    assert.equal(castFraction(c, 2000), 0.5);
    assert.equal(castFraction(c, 9000), 1);
  });
});
