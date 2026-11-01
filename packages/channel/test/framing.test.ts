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

test("bytes travel as raw blobs in a binary frame and come back as Buffers", () => {
  const a = Buffer.from([0, 1, 2, 255]);
  const obj = { type: "wire.send", id: "push-1", payload: { sid: "e-1", data: a, nested: [{ more: new Uint8Array([9, 8]) }] } };
  const frame = encodeFrame(obj);
  assert.equal(frame[4], 0x00, "binary body marker");
  const [got] = new FrameReader().push(frame) as Array<{ payload: { data: Buffer; nested: Array<{ more: Buffer }> } }>;
  assert.ok(Buffer.isBuffer(got.payload.data));
  assert.deepEqual(got.payload.data, a);
  assert.deepEqual(got.payload.nested[0].more, Buffer.from([9, 8]));
});

test("a frame with no bytes stays a JSON frame", () => {
  const frame = encodeFrame({ n: 1 });
  assert.equal(frame[4], 0x7b, "body starts with {");
});

test("binary and JSON frames interleave in one stream", () => {
  const buf = Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ b: Buffer.from("x") }), encodeFrame({ n: 3 })]);
  const r = new FrameReader();
  const out = r.push(buf.subarray(0, 13)).concat(r.push(buf.subarray(13))) as Array<Record<string, unknown>>;
  assert.deepEqual(out[0], { n: 1 });
  assert.deepEqual(out[1].b, Buffer.from("x"));
  assert.deepEqual(out[2], { n: 3 });
});

test("a blob that runs past the body throws", () => {
  const good = encodeFrame({ b: Buffer.from("abc") });
  const bad = Buffer.from(good);
  bad.writeUInt32BE(bad.readUInt32BE(0) - 1, 0);
  assert.throws(() => new FrameReader().push(bad.subarray(0, good.length - 1)), /invalid frame/);
});
