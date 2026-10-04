import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, FrameReader } from "../src/framing.js";

test("round-trips an object", () => {
  const obj = { type: "t", id: "1", payload: { a: [1, 2, "é"] } };
  assert.deepEqual(new FrameReader().push(encodeFrame(obj)), [obj]);
});

test("two frames in one push decode as two objects", () => {
  const buf = Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 })]);
  assert.deepEqual(new FrameReader().push(buf), [{ n: 1 }, { n: 2 }]);
});

test("a frame split across three pushes decodes once", () => {
  const buf = encodeFrame({ hello: "world" });
  const r = new FrameReader();
  assert.deepEqual(r.push(buf.subarray(0, 2)), []);
  assert.deepEqual(r.push(buf.subarray(2, 9)), []);
  assert.deepEqual(r.push(buf.subarray(9)), [{ hello: "world" }]);
});

test("a body over 8 MiB throws", () => {
  assert.throws(() => encodeFrame("x".repeat(8388608)), /frame exceeds 8 MiB/);
});

test("a complete frame of invalid JSON throws", () => {
  const body = Buffer.from("{nope", "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  assert.throws(() => new FrameReader().push(Buffer.concat([header, body])), /invalid frame JSON/);
});
