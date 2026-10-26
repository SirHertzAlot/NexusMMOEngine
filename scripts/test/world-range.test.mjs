import assert from "node:assert/strict";
import { test } from "node:test";
import { regionRangeOf } from "../lib/world-range.mjs";

test("a baked world's inclusive bounds become an exclusive region range", () => {
  assert.equal(regionRangeOf('{"minChunk":-32,"maxChunk":31}'), "-32,-32,32,32");
});
