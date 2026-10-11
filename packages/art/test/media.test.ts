/** Animation-side content: the shipped documents validate, the checks refuse bad edits, the locomotion graph behaves. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LOCOMOTION,
  MEDIA_DOCS,
  MEDIA_DOC_NAMES,
  manifestLocomotion,
  missingAudioEvents,
  pickLocomotion,
  validateLocomotion,
  validateMaterials,
  type GameContent,
  type MaterialsDoc,
} from "../src/media/index.js";

const contentDir = fileURLToPath(new URL("../../../../content/", import.meta.url));
const load = (name: (typeof MEDIA_DOC_NAMES)[number]): unknown => JSON.parse(readFileSync(contentDir + MEDIA_DOCS[name].file, "utf8"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const audioEvents = (): Set<string> => new Set((JSON.parse(readFileSync(contentDir + "audio/events.json", "utf8")) as { events: Array<{ name: string }> }).events.map((e) => e.name));

describe("shipped content", () => {
  for (const name of MEDIA_DOC_NAMES) {
    it(`${MEDIA_DOCS[name].file} validates`, () => {
      assert.deepEqual(MEDIA_DOCS[name].validate(load(name)), []);
    });
  }
  it("every audio event the moves and surfaces name exists in content/audio/events.json", () => {
    const all = Object.fromEntries(MEDIA_DOC_NAMES.map((n) => [n, load(n)])) as GameContent;
    assert.deepEqual(missingAudioEvents(all, audioEvents()), []);
  });
  it("the shipped animation document is a v3 manifest whose graph is the engine default", () => {
    const doc = load("animation") as { version: number; locomotion: unknown };
    assert.equal(doc.version, 3);
    assert.deepEqual(doc.locomotion, DEFAULT_LOCOMOTION);
  });
});

describe("locomotion graph", () => {
  const at = (speed: number, o: { vy?: number; mode?: number; air?: number } = {}) =>
    pickLocomotion(DEFAULT_LOCOMOTION, { speed, vy: o.vy ?? 0, mode: o.mode ?? 0 }, o.air ?? 0);
  it("picks idle, walk, jog and sprint by speed", () => {
    assert.equal(at(0).clip, "Idle_Loop");
    assert.equal(at(1.4).clip, "Walk_Loop");
    assert.equal(at(3.6).clip, "Jog_Fwd_Loop");
    assert.equal(at(6.2).clip, "Sprint_Loop");
  });
  it("scales playback to the speed, within the clamp", () => {
    assert.equal(at(1.4).timeScale, 1);
    assert.ok(Math.abs(at(2.1).timeScale - 1.5) < 1e-9);
    assert.equal(at(0.3).timeScale, 0.6);
    assert.equal(at(12).timeScale, 1.6);
  });
  it("swims, flies and falls", () => {
    assert.equal(at(0, { mode: 1 }).clip, "Swim_Idle_Loop");
    assert.equal(at(2, { mode: 1 }).clip, "Swim_Fwd_Loop");
    assert.equal(at(2, { mode: 2 }).medium, "fly");
    assert.equal(at(3, { air: 0.2 }).clip, "Jump_Loop");
    assert.equal(at(3, { air: 0.01 }).clip, "Jog_Fwd_Loop");
  });
  it("a gait's own fade beats the graph's", () => {
    const g = clone(DEFAULT_LOCOMOTION);
    g.fade = 0.3;
    g.ground[1].fade = 0.05;
    assert.equal(pickLocomotion(g, { speed: 3, vy: 0, mode: 0 }).fade, 0.05);
    assert.equal(pickLocomotion(g, { speed: 1, vy: 0, mode: 0 }).fade, 0.3);
  });
  it("v2 manifests get the default graph, v3 their own, unknown versions none", () => {
    const g = { ...DEFAULT_LOCOMOTION, fade: 0.5 };
    assert.equal(manifestLocomotion({ version: 2 }), DEFAULT_LOCOMOTION);
    assert.equal(manifestLocomotion({ version: 3, locomotion: g }), g);
    assert.equal(manifestLocomotion({ version: 3 }), DEFAULT_LOCOMOTION);
    assert.equal(manifestLocomotion({ version: 4 }), null);
  });
  it("refuses a graph with gaits out of order, a negative fade or a bad clamp", () => {
    const g = clone(DEFAULT_LOCOMOTION);
    g.ground[2].from = 1;
    g.fade = -1;
    g.scale = [2, 1];
    assert.deepEqual(validateLocomotion(g).map((i) => i.path).sort(), ["fade", "ground[2].from", "scale"]);
  });
});

describe("materials and cross-references", () => {
  it("refuses a bad band, a bad tint and a stride out of range", () => {
    const m = clone(load("materials") as MaterialsDoc);
    m.toon.band = [0.9, 0.1];
    m.surfaces.grass.tint = [1, 1, 9];
    m.footstepStride = 99;
    const paths = validateMaterials(m).map((i) => i.path).sort();
    assert.deepEqual(paths, ["footstepStride", "surfaces.grass.tint", "toon.band"]);
  });
  it("a surface or move naming an audio event that is gone is reported", () => {
    const all = Object.fromEntries(MEDIA_DOC_NAMES.map((n) => [n, clone(load(n))])) as GameContent;
    const events = audioEvents();
    events.delete("footstep-stone");
    events.delete("sword-swing");
    const paths = missingAudioEvents(all, events).map((i) => i.path);
    assert.ok(paths.some((p) => p.startsWith("materials: surfaces.rocky-ground.footstep")));
    assert.ok(paths.some((p) => p.startsWith("combat: moves[0].sound.start")));
  });
});
