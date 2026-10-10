/** Sound logic (EA24): variation picking, falloff and panning, voice stealing, bank parsing. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  attenuation,
  eventFiles,
  type Listener,
  parseAudioBank,
  parseSoundEvent,
  pickVariation,
  planPlay,
  type SoundEvent,
  stereoPan,
  VoicePool,
} from "../src/audio/sound-logic.js";

const ev = (over: Partial<SoundEvent> = {}): SoundEvent => ({
  name: "x", bus: "combat", file: "x.ogg", volume: 1, positional: false, maxDistance: 40, pitchRange: [1, 1], priority: 0, ...over,
});
// At the origin, facing -z (so +x is to the right).
const ear: Listener = { x: 0, y: 0, z: 0, fx: 0, fz: -1 };

describe("pickVariation", () => {
  const e = ev({ file: undefined, variations: [{ file: "a", weight: 3 }, { file: "b", weight: 1 }, { file: "c", weight: 0 }] });
  it("follows the weights across the roll", () => {
    assert.equal(pickVariation(e, 0), "a");
    assert.equal(pickVariation(e, 0.74), "a");
    assert.equal(pickVariation(e, 0.75), "b");
    assert.equal(pickVariation(e, 1), "b");
  });
  it("never picks a zero-weight variation, unless every weight is zero", () => {
    for (let r = 0; r <= 1; r += 0.05) assert.notEqual(pickVariation(e, r), "c");
    assert.equal(pickVariation(ev({ file: undefined, variations: [{ file: "z", weight: 0 }] }), 0.5), "z");
  });
  it("a single file is that file", () => assert.equal(pickVariation(ev(), 0.3), "x.ogg"));
  it("lists every file of an event", () => assert.deepEqual(eventFiles(e), ["a", "b", "c"]));
});

describe("attenuation and pan", () => {
  it("is full inside a metre, falls to silence at the max distance", () => {
    assert.equal(attenuation(0.5, 20), 1);
    assert.equal(attenuation(20, 20), 0);
    assert.equal(attenuation(50, 20), 0);
    const near = attenuation(5, 20);
    const far = attenuation(15, 20);
    assert.ok(near > far && far > 0 && near < 1);
  });
  it("pans toward the side the sound is on", () => {
    assert.ok(stereoPan(ear, { x: 10, y: 0, z: 0 }) > 0.9);
    assert.ok(stereoPan(ear, { x: -10, y: 0, z: 0 }) < -0.9);
    assert.equal(stereoPan(ear, { x: 0, y: 0, z: -10 }), 0);
    assert.equal(stereoPan(ear, { x: 0, y: 0, z: 0 }), 0);
  });
  it("turns with the listener", () => {
    const facingEast: Listener = { ...ear, fx: 1, fz: 0 };
    assert.ok(stereoPan(facingEast, { x: 0, y: 0, z: 10 }) > 0.9); // south is on the right when facing east
  });
  it("sounds right beside you barely pan", () => {
    assert.ok(Math.abs(stereoPan(ear, { x: 0.5, y: 0, z: 0 })) < 0.3);
  });
});

describe("planPlay", () => {
  it("a 2D event ignores position", () => {
    const p = planPlay(ev({ volume: 0.7 }), ear, { x: 999, y: 0, z: 0 }, { variation: 0, pitch: 0 });
    assert.deepEqual(p, { file: "x.ogg", gain: 0.7, pitch: 1, pan: 0 });
  });
  it("a positional event is quieter with distance and silent out of range", () => {
    const e = ev({ positional: true, maxDistance: 20 });
    const rolls = { variation: 0, pitch: 0 };
    const near = planPlay(e, ear, { x: 2, y: 0, z: 0 }, rolls)!;
    const far = planPlay(e, ear, { x: 15, y: 0, z: 0 }, rolls)!;
    assert.ok(near.gain > far.gain);
    assert.equal(planPlay(e, ear, { x: 21, y: 0, z: 0 }, rolls), null);
  });
  it("a positional event with no position or listener plays flat", () => {
    assert.equal(planPlay(ev({ positional: true }), ear, null, { variation: 0, pitch: 0 })?.gain, 1);
    assert.equal(planPlay(ev({ positional: true }), null, { x: 5, y: 0, z: 0 }, { variation: 0, pitch: 0 })?.pan, 0);
  });
  it("pitch lies in the range", () => {
    const e = ev({ pitchRange: [0.8, 1.2] });
    assert.equal(planPlay(e, null, null, { variation: 0, pitch: 0 })!.pitch, 0.8);
    assert.equal(planPlay(e, null, null, { variation: 0, pitch: 1 })!.pitch, 1.2);
  });
});

describe("VoicePool", () => {
  it("grants up to the limit per bus, independently", () => {
    const pool = new VoicePool();
    assert.ok(pool.acquire("combat", 2, 0, 1, 0, 1));
    assert.ok(pool.acquire("combat", 2, 0, 1, 0, 1));
    assert.ok(pool.acquire("interface", 2, 0, 1, 0, 1));
    assert.equal(pool.acquire("combat", 2, 0, 0.5, 0, 1), null);
    assert.equal(pool.count("combat"), 2);
  });
  it("frees voices that finished", () => {
    const pool = new VoicePool();
    pool.acquire("combat", 1, 0, 1, 0, 1);
    assert.equal(pool.acquire("combat", 1, 0, 0.5, 0.5, 1), null);
    assert.ok(pool.acquire("combat", 1, 0, 1, 1, 1));
  });
  it("steals the lowest priority, then the quietest, then the oldest", () => {
    const pool = new VoicePool();
    const a = pool.acquire("combat", 3, 5, 1, 0, 10)!.voice;
    const quiet = pool.acquire("combat", 3, 1, 0.2, 1, 10)!.voice;
    const loud = pool.acquire("combat", 3, 1, 0.9, 2, 10)!.voice;
    const r = pool.acquire("combat", 3, 3, 0.5, 3, 10)!;
    assert.equal(r.stolen?.id, quiet.id);
    const r2 = pool.acquire("combat", 3, 3, 0.5, 4, 10)!;
    assert.equal(r2.stolen?.id, loud.id);
    assert.notEqual(r2.stolen?.id, a.id);
  });
  it("a new sound that does not outrank the weakest is dropped", () => {
    const pool = new VoicePool();
    pool.acquire("combat", 1, 5, 1, 0, 10);
    assert.equal(pool.acquire("combat", 1, 4, 1, 1, 10), null); // lower priority
    assert.equal(pool.acquire("combat", 1, 5, 0.5, 1, 10), null); // same priority, quieter
    assert.ok(pool.acquire("combat", 1, 5, 1, 1, 10)); // same priority, as loud: newest wins
  });
  it("release makes room", () => {
    const pool = new VoicePool();
    const v = pool.acquire("combat", 1, 9, 1, 0, 10)!.voice;
    pool.release(v.id);
    assert.equal(pool.acquire("combat", 1, 0, 1, 1, 1)?.stolen, null);
  });
});

describe("parseAudioBank", () => {
  it("fills defaults and clamps", () => {
    const { bank, errors } = parseAudioBank({
      buses: { combat: { gain: 3, maxVoices: 0 } },
      events: [{ name: "a", bus: "combat", file: "a.ogg", volume: 9, pitchRange: [2, 1] }],
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(bank.buses.combat, { gain: 1, maxVoices: 1 });
    assert.deepEqual(bank.buses.interface, { gain: 1, maxVoices: 16 });
    assert.equal(bank.events[0]!.volume, 1);
    assert.deepEqual(bank.events[0]!.pitchRange, [1, 2]);
  });
  it("drops bad events and duplicates, keeps the rest", () => {
    const { bank, errors } = parseAudioBank({
      events: [{ name: "ok", bus: "ui", file: "x" }, { name: "none", bus: "combat" }, { name: "a", bus: "combat", file: "a" }, { name: "a", bus: "combat", file: "b" }, { bus: "combat", file: "c" }],
    });
    assert.deepEqual(bank.events.map((e) => e.name), ["a"]);
    assert.equal(errors.length, 4);
    assert.equal(parseSoundEvent(null), "an event has no name");
  });
  it("reads nothing as an empty bank", () => assert.deepEqual(parseAudioBank(undefined).bank.events, []));

  it("reads the repository's content/audio/events.json without dropping anything", () => {
    const raw = JSON.parse(readFileSync(new URL("../../../../content/audio/events.json", import.meta.url), "utf8")) as unknown;
    const { bank, errors } = parseAudioBank(raw);
    assert.deepEqual(errors, []);
    const bus = (n: string): string | undefined => bank.events.find((e) => e.name === n)?.bus;
    // The hooks in App.tsx fire these.
    assert.equal(bus("hit"), "combat");
    assert.equal(bus("block"), "combat");
    assert.equal(bus("dodge"), "combat");
    assert.equal(bus("pickup"), "interface");
    assert.equal(bus("ui-click"), "interface");
    assert.equal(bus("ui-whisper"), "interface");
    assert.equal(bus("ui-notice"), "interface");
  });
});
