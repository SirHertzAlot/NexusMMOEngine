/** Audio document edits (EA24): the pure half of the Audio panel. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SoundBank, SoundEvent } from "@mmo-engine/client/audio";
import { addClip, addEvent, clipsOf, patchEvent, problems, removeClip, removeEvent, setBus, setClip, toDocument } from "../src/audio-doc.js";

const ev = (over: Partial<SoundEvent>): SoundEvent => ({ name: "x", bus: "combat", volume: 1, positional: false, maxDistance: 40, pitchRange: [1, 1], priority: 0, ...over });
const bank = (): SoundBank => ({
  buses: { master: { gain: 1, maxVoices: 16 }, combat: { gain: 1, maxVoices: 16 }, interface: { gain: 1, maxVoices: 16 }, ambience: { gain: 1, maxVoices: 16 } },
  events: [
    ev({ name: "hit", file: "hit.ogg" }),
    ev({ name: "step", bus: "ambience", variations: [{ file: "a.ogg", weight: 3 }, { file: "b.ogg", weight: 1 }] }),
  ],
});

describe("audio document edits", () => {
  it("patches one event and leaves the rest", () => {
    const next = patchEvent(bank(), "hit", { volume: 0.2, bus: "interface" });
    assert.equal(next.events[0]!.volume, 0.2);
    assert.equal(next.events[0]!.bus, "interface");
    assert.deepEqual(next.events[1], bank().events[1]);
  });

  it("a second clip turns the file into variations, removing back to one turns it back", () => {
    const two = addClip(bank(), "hit");
    assert.equal(two.events[0]!.file, undefined);
    assert.deepEqual(clipsOf(two.events[0]!).map((c) => c.file), ["hit.ogg", "new-clip.ogg"]);
    const one = removeClip(two, "hit", 1);
    assert.equal(one.events[0]!.file, "hit.ogg");
    assert.equal(one.events[0]!.variations, undefined);
  });

  it("the last clip cannot be removed", () => {
    assert.equal(removeClip(bank(), "hit", 0).events[0]!.file, "hit.ogg");
  });

  it("edits a clip's weight and file", () => {
    const next = setClip(setClip(bank(), "step", 1, { weight: 5 }), "step", 0, { file: "c.ogg" });
    assert.deepEqual(next.events[1]!.variations, [{ file: "c.ogg", weight: 3 }, { file: "b.ogg", weight: 5 }]);
  });

  it("sets a bus's mixer settings", () => {
    const next = setBus(bank(), "combat", { maxVoices: 3 });
    assert.deepEqual(next.buses.combat, { gain: 1, maxVoices: 3 });
    assert.equal(next.buses.interface.maxVoices, 16);
  });

  it("adds an event with a free name and removes one", () => {
    const a = addEvent(bank());
    const b = addEvent(a.bank);
    assert.equal(a.name, "new-event");
    assert.equal(b.name, "new-event-2");
    assert.equal(removeEvent(b.bank, "new-event").events.length, 3);
  });

  it("reports duplicates, empty files and all-zero weights", () => {
    let b = patchEvent(bank(), "step", { name: "hit" });
    assert.ok(problems(b).some((p) => /duplicate/.test(p.message)));
    b = setClip(setClip(bank(), "step", 0, { weight: 0 }), "step", 1, { weight: 0 });
    assert.ok(problems(b).some((p) => /weight 0/.test(p.message)));
    assert.ok(problems(setClip(bank(), "hit", 0, { file: " " })).some((p) => /no file/.test(p.message)));
    assert.deepEqual(problems(bank()), []);
  });

  it("the saved document keeps a single file as `file` and several as `variations`", () => {
    const doc = toDocument(addClip(bank(), "hit")) as { events: SoundEvent[] };
    assert.equal(doc.events[0]!.file, undefined);
    assert.equal(doc.events[0]!.variations?.length, 2);
    assert.equal(doc.events[1]!.variations?.length, 2);
    assert.equal((toDocument(bank()) as { events: SoundEvent[] }).events[0]!.file, "hit.ogg");
  });
});
