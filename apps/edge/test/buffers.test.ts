import { test } from "node:test";
import assert from "node:assert/strict";
import { getTickBuffer, pushTick } from "../src/tick-buffer.js";
import { createMirrorBuffer } from "../src/mirror-buffer.js";

test("tick buffer keeps the newest 3600 ticks", () => {
  for (let t = 1; t <= 3700; t++) pushTick(t, t === 3700 ? [{ kind: "hit" }] : []);
  const buf = getTickBuffer();
  assert.equal(buf.length, 3600);
  assert.equal(buf[0].tick, 101);
  assert.deepEqual(buf[buf.length - 1], { tick: 3700, events: [{ kind: "hit" }] });
});

test("mirror buffer keeps the latest snapshot and delta from pushes", () => {
  const handlers = new Map<string, (p: unknown) => void>();
  const mb = createMirrorBuffer({ onPush: (type, h) => { handlers.set(type, h); } });
  assert.equal(mb.latestSnapshot, null);
  const seen: number[] = [];
  mb.onDelta((d) => seen.push(d.tick));
  handlers.get("snapshot")!({ tick: 300, snapshot: "AAA=" });
  handlers.get("tick.delta")!({ tick: 301, delta: "AQ==" });
  handlers.get("tick.delta")!({ tick: 302, delta: "Ag==" });
  assert.deepEqual(mb.latestSnapshot, { tick: 300, snapshot: "AAA=" });
  assert.deepEqual(mb.latestDelta, { tick: 302, delta: "Ag==" });
  assert.deepEqual(seen, [301, 302]);
});
