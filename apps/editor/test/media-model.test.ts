/** Animation editing helpers: timeline markers snap to frames and stay in order, graph rows, rig checks. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_LOCOMOTION, validateLocomotion, validateAnimationDoc, type AnimationManifest } from "@mmo-engine/art";
import { DEFAULT_COMBAT_MOVES, Move, validateCombatMoves, type CombatMove } from "@mmo-engine/protocol";
import { addGait, checkAgainstRig, clipUsage, removeGait, setDuration, setGait, setMarker, stateGraph, stateOf, toFrame, toSec, toggleHit, toggleWindow } from "../src/media-model.js";
import { pickLocomotion } from "@mmo-engine/art";

const move = (id: number): CombatMove => structuredClone(DEFAULT_COMBAT_MOVES.find((m) => m.id === id)!);

describe("combat timeline", () => {
  it("frames and seconds round-trip at 30 Hz", () => {
    assert.equal(toFrame(0.2), 6);
    assert.equal(toSec(6), 0.2);
    assert.equal(toSec(13), 0.4333);
  });
  it("a dragged hit frame snaps to a frame and stays inside the move", () => {
    const a = move(Move.SwordA);
    assert.equal(setMarker(a, "hitAt", 0.2234).hitAt, 0.2333);
    assert.equal(setMarker(a, "hitAt", 9).hitAt, a.duration);
    assert.equal(setMarker(a, "hitAt", -1).hitAt, 0);
    assert.equal(a.hitAt, 0.2, "the original is untouched");
  });
  it("a window's start cannot pass its end, nor its end pass its start", () => {
    const a = move(Move.SwordA);
    assert.equal(setMarker(a, "chain.from", 0.4333).chain!.from, 0.4333);
    const m = setMarker(a, "chain.to", 0.01);
    assert.equal(m.chain!.to, m.chain!.from);
    assert.equal(setMarker(a, "iframes.from", 0.1), a, "no such window: nothing changes");
  });
  it("shortening a move pulls its markers in, and the result still validates", () => {
    const short = setDuration(move(Move.SwordC), 0.3);
    assert.equal(short.hitAt, 0.3);
    assert.equal(short.advance!.to, 0.3);
    const doc = { version: 1, moves: DEFAULT_COMBAT_MOVES.map((m) => (m.id === Move.SwordC ? short : m)) };
    assert.deepEqual(validateCombatMoves(doc), []);
  });
  it("windows and the hit frame toggle on and off", () => {
    const roll = move(Move.Roll);
    const withChain = toggleWindow(roll, "chain", DEFAULT_COMBAT_MOVES);
    assert.ok(withChain.chain && withChain.chain.next !== roll.id);
    assert.equal(toggleWindow(withChain, "chain", DEFAULT_COMBAT_MOVES).chain, undefined);
    assert.equal(toggleHit(toggleHit(roll)).hitAt, undefined);
    assert.equal(toggleHit(roll).hitAt, 0.7333);
  });
});

describe("locomotion editing", () => {
  it("adds, edits and removes gait rows, and the graph validates until an order breaks", () => {
    let g = addGait(DEFAULT_LOCOMOTION, "ground", "Run_Loop");
    assert.equal(g.ground.length, 4);
    assert.deepEqual(validateLocomotion(g), []);
    g = setGait(g, "ground", 3, { from: 1 });
    assert.deepEqual(validateLocomotion(g).map((i) => i.path), ["ground[3].from"]);
    g = removeGait(g, "ground", 3);
    assert.deepEqual(validateLocomotion(g), []);
    assert.equal(DEFAULT_LOCOMOTION.ground.length, 3, "the default is not mutated");
    assert.equal("fade" in setGait(DEFAULT_LOCOMOTION, "ground", 0, { fade: undefined }).ground[0], false);
  });
  it("draws a state per idle and gait, two edges per step, and finds the state a pick lands in", () => {
    const { nodes, edges } = stateGraph(DEFAULT_LOCOMOTION);
    assert.equal(nodes.length, 9, "3 idles + 5 gaits + air");
    assert.equal(edges.length, 5 * 2 + 2);
    const pick = pickLocomotion(DEFAULT_LOCOMOTION, { speed: 3, vy: 0, mode: 0 });
    assert.equal(stateOf(pick, DEFAULT_LOCOMOTION), "ground:1");
    assert.equal(stateOf(pickLocomotion(DEFAULT_LOCOMOTION, { speed: 0, vy: 0, mode: 1 }), DEFAULT_LOCOMOTION), "swim:idle");
    assert.equal(stateOf(pickLocomotion(DEFAULT_LOCOMOTION, { speed: 0, vy: 9, mode: 0 }, 1), DEFAULT_LOCOMOTION), "air");
  });
  it("an edge's fade is the target gait's own, else the graph's", () => {
    const g = setGait({ ...DEFAULT_LOCOMOTION, fade: 0.3 }, "ground", 1, { fade: 0.05 });
    const { edges } = stateGraph(g);
    assert.equal(edges.find((e) => e.from === "ground:0" && e.to === "ground:1")!.fade, 0.05);
    assert.equal(edges.find((e) => e.from === "ground:1" && e.to === "ground:0")!.fade, 0.3);
  });
  it("the shipped animation document validates", () => {
    const doc = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../content/animation/animations.json", import.meta.url)), "utf8"));
    assert.deepEqual(validateAnimationDoc(doc), []);
  });
});

describe("checks against the rig", () => {
  const manifest = (): AnimationManifest => ({
    version: 2,
    sources: [{ id: "ref", title: "", author: "", license: "", url: "", file: "", reference: true }, { id: "ual", title: "", author: "", license: "", url: "", file: "" }],
    clips: [
      { name: "Idle_Loop", source: "ual", duration: 2, loop: true, travel: [0, 0] },
      { name: "Sword_Regular_A", source: "ual", duration: 0.5, loop: false, travel: [0, 0] },
      { name: "Roll", source: "ref", duration: 1.4667, loop: false, travel: [0, 0] },
    ],
  });
  it("names a clip the library lacks, a move that no longer matches its clip, and a reference take", () => {
    const out = checkAgainstRig(manifest(), DEFAULT_LOCOMOTION, DEFAULT_COMBAT_MOVES);
    assert.ok(out.some((l) => l.startsWith("Walk_Loop (ground 0.3+ m/s) is not in")));
    assert.ok(out.some((l) => l.startsWith("sword A: lasts 0.4333 s, its clip Sword_Regular_A lasts 0.500 s")));
    assert.ok(out.some((l) => l.startsWith("roll: Roll is a reference take")));
    assert.ok(!out.some((l) => l.startsWith("Idle_Loop ")));
  });
  it("lists every use of a clip", () => {
    const use = clipUsage(DEFAULT_LOCOMOTION, DEFAULT_COMBAT_MOVES);
    assert.deepEqual(use.get("Swim_Fwd_Loop"), ["swim 0.3+ m/s", "fly 0.5+ m/s"]);
    assert.deepEqual(use.get("Roll"), ["move: roll"]);
  });
});
