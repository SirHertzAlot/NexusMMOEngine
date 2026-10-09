/** Media content: the shipped documents validate, the checks refuse bad edits, the locomotion graph and voice pool behave. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LOCOMOTION,
  MEDIA_DOCS,
  MEDIA_DOC_NAMES,
  VoicePool,
  budgetReport,
  crossCheck,
  manifestLocomotion,
  pickLocomotion,
  validateAudio,
  validateLocomotion,
  type AudioDoc,
  type GameContent,
  type TiersDoc,
  type VfxDoc,
  type Voice,
} from "../src/media/index.js";

const contentDir = fileURLToPath(new URL("../../../../content/", import.meta.url));
const load = (name: (typeof MEDIA_DOC_NAMES)[number]): unknown => JSON.parse(readFileSync(contentDir + MEDIA_DOCS[name].file, "utf8"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("shipped media content", () => {
  for (const name of MEDIA_DOC_NAMES) {
    it(`${MEDIA_DOCS[name].file} validates`, () => {
      assert.deepEqual(MEDIA_DOCS[name].validate(load(name)), []);
    });
  }
  it("documents agree with each other", () => {
    const all = Object.fromEntries(MEDIA_DOC_NAMES.map((n) => [n, load(n)])) as GameContent;
    assert.deepEqual(crossCheck(all), []);
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
    const paths = validateLocomotion(g).map((i) => i.path);
    assert.deepEqual(paths.sort(), ["fade", "ground[2].from", "scale"]);
  });
});

describe("audio events", () => {
  const audio = (): AudioDoc => clone(load("audio") as AudioDoc);
  it("refuses a loop with a one-shot layer, an unknown bus and a hook to nowhere", () => {
    const a = audio();
    a.events["amb.wind"].layers = [{ kind: "tone", wave: "sine", freq: 100, peak: 1, decay: 1 }];
    (a.events.hit as { bus: string }).bus = "radio";
    a.hooks.combat.hit = "nonesuch";
    const paths = validateAudio(a).map((i) => i.path);
    assert.ok(paths.includes("events.amb.wind.layers[0].kind"));
    assert.ok(paths.includes("events.hit.bus"));
    assert.ok(paths.includes("hooks.combat.hit"));
  });
  it("deleting an event a move or a surface uses breaks the cross-check", () => {
    const all = Object.fromEntries(MEDIA_DOC_NAMES.map((n) => [n, clone(load(n))])) as GameContent;
    delete all.audio!.events["step.rock"];
    delete all.audio!.events.swing;
    const paths = crossCheck(all).map((i) => i.path);
    assert.ok(paths.some((p) => p.startsWith("materials: surfaces.rock.footstep")));
    assert.ok(paths.some((p) => p.startsWith("combat: moves[0].sound.start")));
  });
});

describe("voice pool", () => {
  const voice = (event: string, startedAt: number, log: string[], endsAt = Infinity): Voice => ({ event, startedAt, endsAt, stop: () => void log.push(`${event}@${startedAt}`) });
  const play = (pool: VoiceAdmit, event: string, now: number, log: string[], limits: { voices?: number; cooldown?: number } = {}): boolean => {
    if (!pool.admit(event, now, limits)) return false;
    pool.add(voice(event, now, log));
    return true;
  };
  type VoiceAdmit = VoicePool;
  it("cuts the oldest copy of an event past its limit", () => {
    const log: string[] = [];
    const pool = new VoicePool(10);
    for (let i = 0; i < 3; i++) play(pool, "hit", i, log, { voices: 2 });
    assert.deepEqual(log, ["hit@0"]);
    assert.equal(pool.count("hit"), 2);
  });
  it("cuts the oldest voice overall past the global limit", () => {
    const log: string[] = [];
    const pool = new VoicePool(2);
    play(pool, "a", 0, log);
    play(pool, "b", 1, log);
    play(pool, "c", 2, log);
    assert.deepEqual(log, ["a@0"]);
    assert.equal(pool.count(), 2);
  });
  it("refuses a start inside the cooldown and cuts nothing", () => {
    const log: string[] = [];
    const pool = new VoicePool(1);
    assert.ok(play(pool, "step", 0, log, { cooldown: 0.5 }));
    assert.ok(!play(pool, "step", 0.2, log, { cooldown: 0.5 }));
    assert.deepEqual(log, []);
    assert.ok(play(pool, "step", 0.6, log, { cooldown: 0.5 }));
  });
  it("voices that ended free their slot", () => {
    const log: string[] = [];
    const pool = new VoicePool(1);
    pool.admit("a", 0, {});
    pool.add(voice("a", 0, log, 0.5));
    assert.ok(play(pool, "b", 1, log));
    assert.deepEqual(log, []);
  });
});

describe("tier budgets", () => {
  it("flags an effect that holds more live particles than a tier allows", () => {
    const vfx = clone(load("vfx") as VfxDoc);
    const tiers = load("tiers") as TiersDoc;
    assert.deepEqual(budgetReport(vfx, tiers).filter((r) => r.over.length > 0), []);
    vfx.effects.embers.rate = 2000;
    const row = budgetReport(vfx, tiers).find((r) => r.id === "embers")!;
    assert.deepEqual(row.over, ["low", "medium", "high", "ultra"].filter((t) => row.live[t as "low"] > row.budget[t as "low"]));
    assert.ok(row.over.length >= 3);
  });
});
