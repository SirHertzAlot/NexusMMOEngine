import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BONE_BODY, BONE_HEAD, summarizeRig, type Segmentation } from "@mmo-engine/animal-rig";
import { RigSummaryPanel } from "../src/ui/rig-preview.js";

function sampleSeg(skin: Array<[number[], number[]]>): Segmentation {
  const skinIndex = new Uint16Array(skin.length * 4);
  const skinWeight = new Float32Array(skin.length * 4);
  skin.forEach(([idx, w], v) => {
    idx.forEach((b, k) => {
      skinIndex[v * 4 + k] = b;
    });
    w.forEach((x, k) => {
      skinWeight[v * 4 + k] = x;
    });
  });
  return {
    frame: { yaw: 0, dx: 0, dy: 0, dz: 0 },
    length: 2.15,
    height: 1.25,
    width: 0.72,
    legLength: 0.58,
    kneeHeight: 0.24,
    pivots: [],
    skinIndex,
    skinWeight,
  };
}

describe("WL2 editor RigSummaryPanel", () => {
  it("renders rig type, normalised frame dimensions, leg/knee heights, per-bone counts, and unweighted count", () => {
    const seg = sampleSeg([
      [[BONE_BODY, BONE_HEAD, 0, 0], [0.7, 0.3, 0, 0]],
      [[BONE_HEAD, BONE_BODY, 0, 0], [0.8, 0.2, 0, 0]],
      [[0, 0, 0, 0], [0, 0, 0, 0]],
    ]);
    const summary = summarizeRig(seg, 3);
    const html = renderToStaticMarkup(React.createElement(RigSummaryPanel, { summary }));
    assert.ok(html.includes("quadruped"), "shows rig type");
    assert.ok(html.includes("2.15"), "shows normalised length");
    assert.ok(html.includes("0.72"), "shows normalised width");
    assert.ok(html.includes("1.25"), "shows normalised height");
    assert.ok(html.includes("0.58"), "shows leg length");
    assert.ok(html.includes("0.24"), "shows knee height");
    assert.ok(html.includes("body"), "lists body bone");
    assert.ok(html.includes("head"), "lists head bone");
    assert.ok(html.includes("Unweighted"), "shows unweighted label");
    assert.ok(html.includes(">1<") || html.includes(">1 "), "displays unweighted count");
  });
});
