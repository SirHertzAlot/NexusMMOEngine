/** Audio volumes (U4): parsing what storage holds, the slider curve, mute. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VOLUMES, masterGain, parseVolumes, sliderGain } from "../src/audio/volumes.js";
import { CUE_BUS } from "../src/audio/cues.js";

describe("audio volumes", () => {
  it("defaults anything missing or malformed, clamps the rest", () => {
    assert.deepEqual(parseVolumes(null), DEFAULT_VOLUMES);
    assert.deepEqual(parseVolumes("loud"), DEFAULT_VOLUMES);
    assert.deepEqual(parseVolumes({ master: 2, effects: -1, interface: "x", ambience: 0.25, muted: "yes", extra: 1 }), {
      master: 1,
      effects: 0,
      interface: DEFAULT_VOLUMES.interface,
      ambience: 0.25,
      music: DEFAULT_VOLUMES.music,
      muted: false,
    });
    assert.equal(parseVolumes({ muted: true }).muted, true);
  });
  it("the slider curve is squared, so half sounds like half", () => {
    assert.equal(sliderGain(0), 0);
    assert.equal(sliderGain(0.5), 0.25);
    assert.equal(sliderGain(1), 1);
    assert.equal(sliderGain(Number.NaN), 0);
  });
  it("mute silences the master without losing the level", () => {
    const v = { ...DEFAULT_VOLUMES, master: 0.5 };
    assert.equal(masterGain(v), 0.25);
    assert.equal(masterGain({ ...v, muted: true }), 0);
  });
  it("combat cues ride the combat bus, chat and notices the interface bus", () => {
    assert.equal(CUE_BUS.hit, "effects");
    assert.equal(CUE_BUS.block, "effects");
    assert.equal(CUE_BUS.whisper, "interface");
    assert.equal(CUE_BUS.notice, "interface");
  });
});
