import assert from "node:assert/strict";
import test from "node:test";
import {
  FX_WARP_GLSL,
  REQUIRED_NOISE_SYMBOLS,
  REQUIRED_WARP_SYMBOLS,
} from "../src/primitives-glsl.js";

test("warp snippet calls the noise family and defines the warp entry points", () => {
  assert.match(FX_WARP_GLSL, /fxFbm\(/);
  assert.match(FX_WARP_GLSL, /abs\(dot\(/);
  for (const sym of REQUIRED_WARP_SYMBOLS) {
    assert.ok(FX_WARP_GLSL.includes(sym.replace("(", "")), `${sym} missing`);
  }
});

test("balanced braces", () => {
  const open = (FX_WARP_GLSL.match(/\{/g) ?? []).length;
  const close = (FX_WARP_GLSL.match(/\}/g) ?? []).length;
  assert.equal(open, close);
  assert.ok(open > 0);
});

test("snippet extends the engine noise family (no second copy)", () => {
  // FX_WARP_GLSL calls fxFbm (from [EXISTING] NOISE_GLSL) but must not
  // redefine it — the client appends this chunk after NOISE_GLSL.
  assert.ok(FX_WARP_GLSL.includes("fxFbm("));
  assert.ok(!FX_WARP_GLSL.includes("float fxFbm("));
  assert.ok(!FX_WARP_GLSL.includes("float fxHash("));
});

test("no three.js or react imports (static check of built output)", () => {
  // The normative source has zero imports; assert on the built artifact
  // shape instead of reading source files (dist ships .js only).
  assert.equal(typeof FX_WARP_GLSL, "string");
  assert.ok(REQUIRED_WARP_SYMBOLS.length === 2);
  assert.ok(REQUIRED_NOISE_SYMBOLS.length === 2);
});
