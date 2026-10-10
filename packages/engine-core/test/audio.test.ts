/**
 * TDD: EA24 foundation — audio events as data.
 *
 * `content/audio/events.json`: named audio events (footstep, hit, ui-click)
 * with their bus, volume, and 3D/2D playback. The client plays them;
 * defining an event never touches code.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadAudioEvent } from "../src/audio.js";

describe("loadAudioEvent", () => {
  it("loads a 3D positional event", () => {
    const e = loadAudioEvent({
      name: "footstep-grass",
      bus: "ambience",
      file: "footstep-grass.ogg",
      volume: 0.6,
      positional: true,
      maxDistance: 30,
    });
    assert.equal(e.name, "footstep-grass");
    assert.equal(e.positional, true);
  });

  it("loads a 2D UI event", () => {
    const e = loadAudioEvent({
      name: "ui-click",
      bus: "interface",
      file: "ui-click.ogg",
      volume: 0.8,
      positional: false,
    });
    assert.equal(e.positional, false);
  });

  it("rejects a bad bus", () => {
    assert.throws(() => loadAudioEvent({
      name: "x", bus: "nope", file: "x.ogg", volume: 1, positional: false,
    }), /bus/);
  });

  it("rejects volume outside 0-1", () => {
    assert.throws(() => loadAudioEvent({
      name: "x", bus: "interface", file: "x.ogg", volume: 2, positional: false,
    }), /volume/);
  });

  it("fills defaults", () => {
    const e = loadAudioEvent({ name: "x", bus: "combat", file: "x.ogg" });
    assert.equal(e.volume, 1);
    assert.equal(e.positional, false);
  });

  it("accepts variations (surface-dependent footsteps)", () => {
    const e = loadAudioEvent({
      name: "footstep",
      bus: "ambience",
      variations: [
        { file: "step-grass.ogg", weight: 3 },
        { file: "step-stone.ogg", weight: 1 },
      ],
    });
    assert.equal(e.variations?.length, 2);
  });
});
