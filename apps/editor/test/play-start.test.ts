/**
 * requestPlayStart: toolbar Play / F5 / Play menu start the play server.
 * When the panel isn't mounted yet, the request waits for it instead of
 * being lost.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPlayStartPending, requestPlayStart } from "../src/ui/play-mode.js";

describe("requestPlayStart", () => {
  it("a request before the panel mounts waits instead of throwing", () => {
    assert.equal(isPlayStartPending(), false);
    requestPlayStart();
    assert.equal(isPlayStartPending(), true);
  });
});
