/**
 * EA21 clip map and playback planning: the server's Animation row becomes
 * a clip, layers, a playhead and crossfade weights, with no three.js.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ClipId } from "@mmo-engine/protocol";
import { DEFAULT_CLIP_MAP, LAYER_BASE, LAYER_UPPER, checkClipMap, clampRate, crossfadeWeights, indexClipMap, layersOf, nextClipId, parseClipMap, planClip, playhead, secondsSince, } from "../src/character/index.js";
import { CLIP_NAMES } from "@mmo-engine/protocol";
const map = indexClipMap(DEFAULT_CLIP_MAP);
const row = (over = {}) => ({
    clipId: ClipId.Walk,
    startTick: 100,
    rate: 1,
    layerMask: LAYER_BASE,
    ...over,
});
describe("clip map", () => {
    it("the default map is valid and covers every named clip id", () => {
        assert.deepEqual(checkClipMap(DEFAULT_CLIP_MAP), []);
        for (const id of Object.values(ClipId)) {
            if (id !== ClipId.None && CLIP_NAMES[id]) {
                assert.ok(map.has(id), `clip id ${id}`);
            }
        }
    });
    it("the shipped content/animation/clips.json is a valid map for every named clip id", () => {
        const file = fileURLToPath(new URL("../../../../content/animation/clips.json", import.meta.url));
        const shipped = parseClipMap(JSON.parse(readFileSync(file, "utf8")));
        for (const id of Object.values(ClipId))
            if (id !== ClipId.None)
                assert.ok(indexClipMap(shipped).has(id), `clip id ${id}`);
    });
    it("flags duplicate ids, empty names, ids out of range and bad fades as errors", () => {
        const bad = {
            version: 1,
            clips: [
                { id: 1, name: "a", clip: "A", loop: true, fade: 0.1 },
                { id: 1, name: "b", clip: "B", loop: true, fade: 0.1 },
                { id: 0, name: "c", clip: "C", loop: true, fade: 0.1 },
                { id: 3, name: "", clip: "", loop: true, fade: 0.1 },
                { id: 4, name: "e", clip: "E", loop: "yes", fade: 9 },
            ],
        };
        const errors = checkClipMap(bad).filter((i) => i.severity === "error");
        assert.deepEqual(errors.map((i) => [i.row, i.field]), [[1, "id"], [2, "id"], [3, "name"], [3, "clip"], [4, "loop"], [4, "fade"]]);
        assert.throws(() => parseClipMap(bad), /row 2: id 1 is already used by row 1/);
    });
    it("warns, without blocking, about a clip the library lacks", () => {
        const issues = checkClipMap(DEFAULT_CLIP_MAP, ["Idle_Loop"]);
        assert.ok(issues.length > 0 && issues.every((i) => i.severity === "warn" && i.field === "clip"));
        assert.equal(parseClipMap(DEFAULT_CLIP_MAP), DEFAULT_CLIP_MAP);
    });
    it("refuses a document that is not a v1 clip map", () => {
        assert.match(checkClipMap([])[0].message, /object/);
        assert.equal(checkClipMap({ version: 2, clips: [] })[0].field, "version");
        assert.equal(checkClipMap({ version: 1 })[0].field, "clips");
    });
    it("proposes the next free id", () => {
        assert.equal(nextClipId(DEFAULT_CLIP_MAP), ClipId.Cast + 1);
        assert.equal(nextClipId({ version: 1, clips: [] }), 1);
    });
});
describe("planClip", () => {
    it("maps the clip id to its library clip, with the elapsed time from the start tick", () => {
        const plan = planClip(row({ clipId: ClipId.Jog, startTick: 90 }), map, 120, 30);
        assert.equal(plan.clip, "Jog_Fwd_Loop");
        assert.equal(plan.elapsed, 1);
        assert.equal(plan.loop, true);
        assert.equal(plan.key, `${ClipId.Jog}:90`);
    });
    it("has no plan for no row, clip 0 (the locomotion fallback) or an unknown id", () => {
        assert.equal(planClip(undefined, map, 1, 30), null);
        assert.equal(planClip(row({ clipId: 0 }), map, 1, 30), null);
        assert.equal(planClip(row({ clipId: 999 }), map, 1, 30), null);
    });
    it("reads the layer mask as layers (an empty mask is the base)", () => {
        assert.deepEqual(layersOf(LAYER_BASE), { base: true, upper: false });
        assert.deepEqual(layersOf(LAYER_UPPER), { base: false, upper: true });
        assert.deepEqual(layersOf(LAYER_BASE | LAYER_UPPER), { base: true, upper: true });
        assert.deepEqual(layersOf(0), { base: true, upper: false });
        assert.deepEqual(planClip(row({ clipId: ClipId.AttackSwordA, layerMask: LAYER_UPPER }), map, 100, 30).layers, { base: false, upper: true });
    });
    it("keeps the rate in a range the mixer can play", () => {
        assert.equal(clampRate(1.5), 1.5);
        assert.equal(clampRate(0), 0.1);
        assert.equal(clampRate(100), 4);
        assert.equal(clampRate(Number.NaN), 1);
        assert.equal(planClip(row({ rate: 2 }), map, 100, 30).timeScale, 2);
    });
    it("a clip that starts on a later tick has not started yet", () => {
        assert.equal(secondsSince(110, 100, 30), 0);
        assert.equal(planClip(row({ startTick: 110 }), map, 100, 30).elapsed, 0);
    });
    it("a repeat of the same clip is a new key (the same attack twice restarts)", () => {
        const a = planClip(row({ clipId: ClipId.AttackSwordA, startTick: 100 }), map, 101, 30);
        const b = planClip(row({ clipId: ClipId.AttackSwordA, startTick: 130 }), map, 131, 30);
        assert.notEqual(a.key, b.key);
    });
});
describe("playhead", () => {
    it("wraps a loop and holds a one-shot on its last pose", () => {
        assert.equal(playhead(2.5, 1, 1, true), 0.5);
        assert.equal(playhead(2.5, 1, 1, false), 1);
        assert.equal(playhead(1, 2, 3, true), 2);
        assert.equal(playhead(-1, 1, 3, true), 0);
        assert.equal(playhead(1, 1, 0, true), 0);
    });
});
describe("crossfadeWeights", () => {
    it("goes from the old clip to the new one and always sums to 1", () => {
        assert.deepEqual(crossfadeWeights(0, 0.2), { from: 1, to: 0 });
        assert.deepEqual(crossfadeWeights(0.2, 0.2), { from: 0, to: 1 });
        assert.deepEqual(crossfadeWeights(0.1, 0.2), { from: 0.5, to: 0.5 });
        for (let t = 0; t <= 0.25; t += 0.01) {
            const w = crossfadeWeights(t, 0.2);
            assert.ok(Math.abs(w.from + w.to - 1) < 1e-12);
            assert.ok(w.to >= 0 && w.to <= 1);
        }
    });
    it("eases: slow at both ends, never behind the straight line early on", () => {
        assert.ok(crossfadeWeights(0.02, 0.2).to < 0.1);
        assert.ok(crossfadeWeights(0.18, 0.2).to > 0.9);
    });
    it("a zero-length fade is a cut", () => {
        assert.deepEqual(crossfadeWeights(0, 0), { from: 0, to: 1 });
    });
});
