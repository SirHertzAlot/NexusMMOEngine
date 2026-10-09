/**
 * TDD: Multi-client play mode.
 * The Play menu offers 1/2/4/8 clients; the controller connects that
 * many mirror clients to the owned server. Client 0 is the primary
 * (drives the game view); the rest are headless load.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clientCount, type PlaySetup } from "../src/ui/play-setup.js";
import { defaultPlaySetup } from "../src/ui/play-setup.js";

const setup = (clients: string): PlaySetup => ({ ...defaultPlaySetup(), clients });

describe("multi-client", () => {
  it("parses 1/2/4/8", () => {
    assert.equal(clientCount(setup("1")), 1);
    assert.equal(clientCount(setup("2")), 2);
    assert.equal(clientCount(setup("4")), 4);
    assert.equal(clientCount(setup("8")), 8);
  });

  it("clamps invalid to 1", () => {
    assert.equal(clientCount(setup("0")), 1);
    assert.equal(clientCount(setup("abc")), 1);
    assert.equal(clientCount(setup("16")), 1);
  });

  it("only 1, 2, 4, 8 are valid", () => {
    assert.equal(clientCount(setup("3")), 1);
    assert.equal(clientCount(setup("5")), 1);
  });
});
