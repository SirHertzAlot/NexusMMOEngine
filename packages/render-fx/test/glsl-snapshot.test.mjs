import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(here, "../src/primitives-glsl.ts"), "utf8");

test("warp snippet references fxFbm and abs(dot(", () => {
  assert.match(SRC, /fxFbm\(/);
  assert.match(SRC, /abs\(dot\(/);
});

test("both entry points present", () => {
  assert.ok(SRC.includes("fxWarp2"), "fxWarp2 missing");
  assert.ok(SRC.includes("prim_fresnel"), "prim_fresnel missing");
});

test("balanced braces", () => {
  const open = (SRC.match(/\{/g) ?? []).length;
  const close = (SRC.match(/\}/g) ?? []).length;
  assert.equal(open, close);
  assert.ok(open > 0);
});

test("no three.js or react imports in primitives", () => {
  assert.ok(!SRC.includes("from \"three\""));
  assert.ok(!SRC.includes("from \"react\""));
});
