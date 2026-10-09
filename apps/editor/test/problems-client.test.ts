import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { problemLink } from "../src/problems-client.js";

describe("problemLink", () => {
  it("opens the workspace view that owns each source", () => {
    assert.equal(problemLink({ source: "flow", file: "x" }), "#/flow/flow");
    assert.equal(problemLink({ source: "hud", file: "x" }), "#/flow/hud");
    assert.equal(problemLink({ source: "build", file: "x" }), "#/release/pipeline");
    assert.equal(problemLink({ source: "media", file: "content/vfx/effects.json" }), "#/artaudio/vfx");
    assert.equal(problemLink({ source: "media", file: "content/audio/events.json" }), "#/artaudio/audio");
    assert.equal(problemLink({ source: "media", file: "content/combat/moves.json" }), "#/artaudio/animation");
  });
});
