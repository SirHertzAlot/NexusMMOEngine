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

import { loadAudioBank } from "../src/audio.js";

describe("loadAudioBank", () => {
  it("fills bus and event defaults", () => {
    const b = loadAudioBank({ events: [{ name: "x", bus: "combat", file: "x.ogg" }] });
    assert.deepEqual(b.buses, {});
    assert.deepEqual(b.events[0]?.pitchRange, [1, 1]);
    assert.equal(b.events[0]?.priority, 0);
  });

  it("reads bus settings", () => {
    const b = loadAudioBank({ buses: { combat: { gain: 0.5, maxVoices: 4 } }, events: [] });
    assert.deepEqual(b.buses.combat, { gain: 0.5, maxVoices: 4 });
  });

  it("rejects duplicate names, all-zero variations and a reversed pitch range", () => {
    const e = { name: "x", bus: "combat", file: "x.ogg" };
    assert.throws(() => loadAudioBank({ events: [e, e] }), /duplicate/);
    assert.throws(() => loadAudioBank({ events: [{ ...e, file: undefined, variations: [{ file: "a", weight: 0 }] }] }), /weight 0/);
    assert.throws(() => loadAudioBank({ events: [{ ...e, pitchRange: [2, 1] }] }), /pitchRange/);
  });

  it("accepts the repository's content/audio/events.json", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(new URL("../../../../content/audio/events.json", import.meta.url), "utf8")) as unknown;
    assert.ok(loadAudioBank(raw).events.length >= 3);
  });
});
