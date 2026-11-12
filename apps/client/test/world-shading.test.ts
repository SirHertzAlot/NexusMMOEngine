/**
 * Unified cel shading: every world class is cel or carries a recorded
 * opt-out, the cel band follows the quality tier's feather, and the
 * registry matches the art package's shading kinds.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { SHADING_KINDS, SHADING_OPT_OUTS } from "@mmo-engine/art/browser";
import { toonOf } from "../src/render/toon/toon-material.js";
import {
  applyShadingToMaterial,
  celBand,
  setCelFeather,
  setShadingContent,
  shadingFor,
} from "../src/render/shading/shading.js";
import { WORLD_CLASSES, optOutOf } from "../src/render/shading/world-classes.js";
import { QUALITY_PRESETS, QUALITY_TIERS } from "../src/render/quality.js";

describe("world shading registry", () => {
  it("every world class is cel or carries a non-empty opt-out reason", () => {
    for (const c of WORLD_CLASSES) {
      if ("kind" in c.path) {
        assert.ok(SHADING_KINDS.includes(c.path.kind), `${c.id}: kind ${c.path.kind} is in the art schema`);
      } else {
        const reason = optOutOf(c);
        assert.ok(reason && reason.length > 0, `${c.id}: opt-out needs a reason`);
      }
    }
  });

  it("every cel class resolves to the toon patch by default", () => {
    setShadingContent(undefined);
    for (const c of WORLD_CLASSES) {
      if (!("kind" in c.path)) continue;
      const m = new THREE.MeshStandardMaterial();
      applyShadingToMaterial(m, c.path.kind);
      assert.ok(shadingFor(c.path.kind).includes("toon"), `${c.id}: default kind is cel`);
      assert.ok(toonOf(m), `${c.id}: a standard material takes the toon patch`);
    }
  });

  it("covers every art shading kind, so none is left unshaded by accident", () => {
    const used = new Set(WORLD_CLASSES.flatMap((c) => ("kind" in c.path ? [c.path.kind] : [])));
    for (const kind of SHADING_KINDS) assert.ok(used.has(kind), `kind ${kind} is used by some world class`);
  });

  it("every opt-out in the art record is used by some world class", () => {
    const used = new Set(WORLD_CLASSES.flatMap((c) => ("optOut" in c.path ? [c.path.optOut] : [])));
    for (const id of Object.keys(SHADING_OPT_OUTS)) assert.ok(used.has(id as keyof typeof SHADING_OPT_OUTS), `${id} is used`);
  });
});

describe("cel band feather", () => {
  it("a hard tier gives a step (zero width)", () => {
    setCelFeather(0);
    const [lo, hi] = celBand();
    assert.equal(lo, hi);
  });

  it("a feathered tier gives the content's band width", () => {
    setCelFeather(0.03);
    const [lo, hi] = celBand();
    assert.ok(Math.abs(hi - lo - 0.03) < 1e-9, `width ${hi - lo}`);
    setCelFeather(0);
  });

  it("the low tier is hard, the others feathered", () => {
    assert.equal(QUALITY_PRESETS.low.celFeather, 0);
    for (const t of QUALITY_TIERS.filter((t) => t !== "low")) assert.ok(QUALITY_PRESETS[t].celFeather > 0, t);
  });
});
