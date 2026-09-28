import test from "node:test";
import assert from "node:assert/strict";
import {
  makeWireEntityId,
  parseWireEntityId,
  VERSION,
} from "../src/index.js";

test("package surface loads", () => {
  assert.equal(VERSION, "0.1.0");
});

test("wire entity id packs generation + slot", () => {
  // generation 1, slot 2 -> 0x00000001_00000002
  assert.equal(makeWireEntityId(1, 2), 0x100000002n);
  assert.equal(makeWireEntityId(0, 0), 0n);
  assert.equal(
    makeWireEntityId(0xffffffff, 0xffffffff),
    0xffffffffffffffffn,
  );
});

test("wire entity id round-trips through parse", () => {
  for (const [gen, slot] of [
    [0, 0],
    [1, 2],
    [7, 123456],
    [0xffffffff, 0xffffffff],
  ] as const) {
    const id = makeWireEntityId(gen, slot);
    assert.deepEqual(parseWireEntityId(id), { generation: gen, slot });
  }
});

test("generation bump on slot reuse changes the id (ABA guard)", () => {
  const slot = 42;
  const first = makeWireEntityId(0, slot);
  const reused = makeWireEntityId(1, slot);
  assert.notEqual(first, reused);
  assert.equal(parseWireEntityId(reused).generation, 1);
});

test("out-of-range inputs throw RangeError", () => {
  assert.throws(() => makeWireEntityId(-1, 0), RangeError);
  assert.throws(() => makeWireEntityId(0x100000000, 0), RangeError);
  assert.throws(() => makeWireEntityId(0, -1), RangeError);
  assert.throws(() => makeWireEntityId(0, 1.5), RangeError);
  assert.throws(() => parseWireEntityId(-1n), RangeError);
  assert.throws(() => parseWireEntityId(0x10000000000000000n), RangeError);
});
