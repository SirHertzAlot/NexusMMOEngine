/** Toon preview colours: linear <-> sRGB round-trips, and the band cuts shadow from light. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Rgb } from "@mmo-engine/art";
import { hexToLinear, linearToHex, toonColour } from "../src/toon-preview.js";

describe("toon preview", () => {
  it("hex and linear round-trip", () => {
    for (const hex of ["#000000", "#ffffff", "#8b5a2b", "#336699"]) assert.equal(linearToHex(hexToLinear(hex)), hex);
  });
  const toon = { band: [0.42, 0.45] as [number, number], rim: 0, rimPower: 6 };
  const base: Rgb = [0.8, 0.8, 0.8];
  const ramp: [Rgb, Rgb] = [[0.2, 0.2, 0.2], [0.5, 0.5, 0.5]];
  it("full light shows the base colour, the far side the darkest ramp stop", () => {
    assert.deepEqual(toonColour(1, 1, base, ramp, toon).map((v) => +v.toFixed(3)), [0.8, 0.8, 0.8]);
    assert.deepEqual(toonColour(-1, 1, base, ramp, toon).map((v) => +v.toFixed(3)), [0.16, 0.16, 0.16]);
  });
  it("moving the band edge moves where the shadow starts", () => {
    const at = (band: [number, number]): number => toonColour(0.1, 1, base, ramp, { ...toon, band })[0];
    assert.ok(at([0.7, 0.8]) < at([0.2, 0.3]), "a higher band edge shadows the same point more");
  });
});
