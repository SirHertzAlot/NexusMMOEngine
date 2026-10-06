/**
 * Art & audio center views bind to the dock selection: every clip id has
 * animation data, every effect id has VFX data, and every audio event has
 * event data — so picking in the dock always changes the panel.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ANIM_CLIPS,
  AUDIO_EVENTS,
  AUDIO_EVENT_DATA,
  CLIPS,
  EFFECTS,
  VFX_EFFECTS,
} from "../src/ui/previews.js";

describe("art selection data coverage", () => {
  it("every clip has animation data with sane frames", () => {
    for (const [id] of CLIPS) {
      const d = ANIM_CLIPS[id];
      assert.ok(d, `clip ${id} has no ANIM_CLIPS entry`);
      assert.ok(d.frames > 0 && d.fps > 0, `clip ${id} has bad frames/fps`);
      assert.ok(
        ["Idle", "Walk", "Jog", "Air", "Sprint", "Swim"].includes(d.loco),
        `clip ${id} highlights unknown locomotion state ${d.loco}`,
      );
    }
  });

  it("every effect has VFX data with a seed and budgets", () => {
    for (const [id] of EFFECTS) {
      const d = VFX_EFFECTS[id];
      assert.ok(d, `effect ${id} has no VFX_EFFECTS entry`);
      assert.equal(d.colors.length, 3);
      assert.ok(d.budgets.length > 0, `effect ${id} has no budgets`);
    }
  });

  it("effect seeds are distinct (different particle fields)", () => {
    const seeds = Object.values(VFX_EFFECTS).map((d) => d.seed);
    assert.equal(new Set(seeds).size, seeds.length);
  });

  it("every audio event has clips, mixer fields and firing moves", () => {
    for (const [, evts] of AUDIO_EVENTS) {
      for (const [id] of evts) {
        const d = AUDIO_EVENT_DATA[id];
        assert.ok(d, `event ${id} has no AUDIO_EVENT_DATA entry`);
        assert.ok(d.clips.length > 0, `event ${id} has no clips`);
        assert.ok(d.firedBy.length > 0, `event ${id} has no firing moves`);
      }
    }
  });
});
