/** The Rig view's pure model: chains from a bone tree, tips from skin weights, region/heat colours, the foot trace. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  boneColor, chainPoints, discoverChains, FootTrace, heatColors, isolateColors, partOfVertex, poleFor, regionColors, tipsFromSkin,
  type RigBone,
} from "../src/rig-model.js";

// body (root) -> head, tail1 -> tail2 -> tail3, upperFL -> lowerFL, upperHL -> lowerHL (the auto rig's shape).
const BONES: RigBone[] = [
  { name: "body", parent: -1, rest: [0, 1, 0] },
  { name: "head", parent: 0, rest: [0, 1.2, 0.6] },
  { name: "tail1", parent: 0, rest: [0, 1.1, -0.5] },
  { name: "tail2", parent: 2, rest: [0, 1.05, -0.7] },
  { name: "tail3", parent: 3, rest: [0, 1.0, -0.9] },
  { name: "upperFL", parent: 0, rest: [0.2, 1, 0.4] },
  { name: "lowerFL", parent: 5, rest: [0.2, 0.5, 0.4] },
  { name: "upperHL", parent: 0, rest: [0.2, 1, -0.4] },
  { name: "lowerHL", parent: 7, rest: [0.2, 0.5, -0.4] },
];

describe("discoverChains", () => {
  const chains = discoverChains(BONES);
  const byId = Object.fromEntries(chains.map((c) => [c.id, c]));
  it("finds one chain per leaf, named by its tip bone", () => {
    assert.deepEqual(chains.map((c) => c.id).sort(), ["head", "lowerFL", "lowerHL", "tail3"]);
  });
  it("walks up while a bone has a single child, root first, and stops at a branching bone", () => {
    assert.deepEqual(byId.lowerFL.bones, [5, 6]);
    assert.deepEqual(byId.tail3.bones, [2, 3, 4]);
    assert.deepEqual(byId.head.bones, [1]);
  });
  it("one bone aims, two bones are a limb, more are a FABRIK chain", () => {
    assert.equal(byId.head.kind, "aim");
    assert.equal(byId.lowerFL.kind, "limb2");
    assert.equal(byId.tail3.kind, "fabrik");
  });
  it("a long single-child run is capped", () => {
    const line: RigBone[] = Array.from({ length: 30 }, (_, i) => ({ name: `b${i}`, parent: i - 1, rest: [0, 0, i * 0.1] }));
    const c = discoverChains(line);
    assert.equal(c.length, 1);
    assert.ok(c[0].bones.length <= 8);
    assert.equal(c[0].bones[c[0].bones.length - 1], 29);
  });
});

describe("tips and chain points", () => {
  it("a leaf bone's tip is the far end of the vertices it owns", () => {
    // Four vertices owned by lowerFL (6) hanging down to the ground, two by body.
    const pos = [0.2, 0.5, 0.4, 0.2, 0.3, 0.4, 0.21, 0.01, 0.4, 0.19, 0, 0.4, 0, 1, 0, 0, 0.9, 0];
    const idx = [6, 0, 0, 0, 6, 0, 0, 0, 6, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const w = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    const tips = tipsFromSkin(BONES, pos, idx, w);
    assert.ok(Math.abs(tips[6][1] - 0.005) < 0.02, `tip y ${tips[6][1]}`);
    assert.ok(Math.abs(tips[6][0] - 0.2) < 0.02);
    // A bone with a child ends where the child starts.
    assert.deepEqual(tips[5], BONES[6].rest);
  });
  it("a leaf with no vertices still gets a tip below its pivot", () => {
    const tips = tipsFromSkin(BONES, [], [], []);
    assert.ok(tips[1][1] < BONES[1].rest[1]);
  });
  it("chainPoints are the joints then the tip, and lengths follow", () => {
    const tips = tipsFromSkin(BONES, [], [], []);
    tips[6] = [0.2, 0, 0.4];
    const p = chainPoints(BONES, discoverChains(BONES).find((c) => c.id === "lowerFL")!, tips);
    assert.deepEqual(Array.from(p), [0.2, 1, 0.4, 0.2, 0.5, 0.4, 0.2, 0, 0.4]);
  });
});

describe("poleFor", () => {
  it("front legs bend forward at the carpus, hind legs back at the hock, anything else forward", () => {
    assert.deepEqual(poleFor("lowerFL", [0, 1, 0.4]), [0, 0, 1]);
    assert.deepEqual(poleFor("lowerHR", [0, 1, -0.4]), [0, 0, -1]);
    assert.deepEqual(poleFor("hand", [0, 1, 0]), [0, 0, 1]);
  });
});

// Two vertices: a pure body one and a half body, half leg one.
const IDX = [0, 6, 0, 0, 0, 6, 0, 0];
const W = [1, 0, 0, 0, 0.5, 0.5, 0, 0];
describe("colours", () => {
  it("the same bone always has the same colour and neighbours differ", () => {
    assert.deepEqual(boneColor(3), boneColor(3));
    assert.notDeepEqual(boneColor(3), boneColor(4));
  });
  it("region colours blend by weight", () => {
    const out = new Float32Array(6);
    regionColors(IDX, W, out);
    assert.deepEqual(Array.from(out.slice(0, 3)), Array.from(boneColor(0)).map((c) => Math.fround(c)));
    const mix = boneColor(0).map((c, k) => Math.fround(c * 0.5 + boneColor(6)[k] * 0.5));
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(out[3 + k] - mix[k]) < 1e-6);
  });
  it("heat is blue at no weight and red at full weight, for the chosen bone", () => {
    const out = new Float32Array(6);
    heatColors(IDX, W, 6, out);
    assert.ok(out[2] > out[0], "no weight is blue");
    assert.ok(out[3] > 0.4 && out[3] >= out[5], "half weight is warmer");
    heatColors(IDX, [1, 0, 0, 0, 0, 1, 0, 0], 6, out);
    assert.ok(out[3] > 0.9 && out[5] < 0.2, "full weight is red");
  });
  it("isolating a bone keeps its vertices bright and greys out the rest", () => {
    const out = new Float32Array(6);
    isolateColors(IDX, W, 6, out);
    assert.ok(Math.abs(out[0] - out[1]) < 1e-6 && Math.abs(out[1] - out[2]) < 1e-6, "body vertex is grey");
    assert.ok(out[3] !== out[4] || out[4] !== out[5], "leg-weighted vertex is coloured");
  });
  it("partOfVertex is the strongest influence", () => {
    assert.equal(partOfVertex(IDX, W, 0), 0);
    assert.equal(partOfVertex([3, 5, 0, 0], [0.2, 0.8, 0, 0], 0), 5);
  });
});

describe("FootTrace", () => {
  it("keeps segments between consecutive samples and forgets the oldest", () => {
    const t = new FootTrace(4);
    for (let i = 0; i < 6; i++) t.push(i, 0, 0, i * 0.1);
    assert.equal(t.count, 4);
    const lines = t.segments;
    assert.equal(lines.length, 4 * 6);
    // Every stored segment joins samples one apart (none spans the ring's seam).
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(lines[k * 6 + 3] - lines[k * 6] - 1) < 1e-6 || lines[k * 6 + 3] === lines[k * 6]);
  });
  it("a foot planted on the treadmill does not slide, one skating does", () => {
    // Treadmill at 2 m/s: the ground runs backwards (-z). A planted foot's z follows it.
    const planted = new FootTrace(32);
    for (let i = 0; i < 20; i++) planted.push(0, 0, -2 * i * 0.05, i * 0.05);
    const s = planted.stanceSlide(2, 0.03);
    assert.ok(s.samples > 10);
    assert.ok(s.max < 0.01, `planted slides ${s.max}`);
    const skating = new FootTrace(32);
    for (let i = 0; i < 20; i++) skating.push(0, 0, -1 * i * 0.05, i * 0.05);
    assert.ok(skating.stanceSlide(2, 0.03).max > 0.9, "skating foot slides 1 m/s");
  });
  it("feet above the stance height are not counted", () => {
    const t = new FootTrace(8);
    for (let i = 0; i < 6; i++) t.push(0, 0.5, -i * 0.1, i * 0.05);
    assert.equal(t.stanceSlide(2, 0.03).samples, 0);
  });
});
