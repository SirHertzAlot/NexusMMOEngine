import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { encodeDeltaSet, encodeEnvelope, MessageType, DeltaSetKind } from "@mmo-engine/protocol";

const require = createRequire(import.meta.url);
const fanout = require("../index.js");

const rnd = (n, seed) => {
  const b = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; b[i] = x >>> 24; }
  return b;
};

test("assemble is byte-identical to encodeEnvelope(DeltaSet, encodeDeltaSet)", () => {
  const sectors = ["g", "0,0", "-3,12", "12,-7"];
  sectors.forEach((n, i) => fanout.setName(i, new TextEncoder().encode(n)));
  const payloads = [rnd(0, 1), rnd(1, 2), rnd(500, 3), rnd(70000, 4)];
  const sessions = [
    { replace: false, entries: [[DeltaSetKind.Delta, 0, 2], [DeltaSetKind.Delta, 1, 3]] },
    { replace: true, entries: [[DeltaSetKind.Full, 2, 2], [DeltaSetKind.Leave, 3, 0], [DeltaSetKind.Pinned, 0, 1]] },
    { replace: false, entries: [] },
  ];
  const desc = [];
  for (const s of sessions) { desc.push(s.entries.length, s.replace ? 1 : 0); for (const e of s.entries) desc.push(...e); }
  const tick = 0xfffffff0;
  const out = new Int32Array(sessions.length * 2);
  let arena = new Uint8Array(16);
  let r = fanout.assemble(tick, arena, out, Int32Array.from(desc), desc.length, payloads);
  assert.ok(r < 0, "a small arena reports the size needed");
  arena = new Uint8Array(-r);
  r = fanout.assemble(tick, arena, out, Int32Array.from(desc), desc.length, payloads);
  assert.equal(r, sessions.length);
  sessions.forEach((s, i) => {
    const want = encodeEnvelope(MessageType.DeltaSet, encodeDeltaSet({
      tick, replace: s.replace,
      entries: s.entries.map(([kind, name, p]) => ({ kind, sector: sectors[name], bytes: payloads[p] })),
    }));
    const got = arena.subarray(out[i * 2], out[i * 2] + out[i * 2 + 1]);
    assert.deepEqual(Buffer.from(got), Buffer.from(want), `session ${i}`);
  });
});

test("selectNames names each id once per session, and release forgets", () => {
  const ids = BigUint64Array.from([10n, 11n, 12n, 20n, 21n]);
  const start = Int32Array.from([0, 3]), len = Int32Array.from([3, 2]);
  // session slot 5: player 99, sectors 0 and 1, pinned [12n (dup), 30n]
  const desc = Int32Array.from([5, 1, 2, 2, 0, 1]);
  const pids = BigUint64Array.from([99n, 12n, 30n]);
  const cnt = new Int32Array(1);
  const sel = () => { const n = fanout.selectNames(start, len, ids, desc, desc.length, pids, cnt); const w = new BigUint64Array(n); fanout.takeWanted(w); return w; };
  let w = sel();
  assert.deepEqual([...w], [99n, 10n, 11n, 12n, 20n, 21n, 30n]);
  w = sel();
  assert.equal(w.length, 0, "second tick: nothing new");
  fanout.release(5);
  w = sel();
  assert.equal(cnt[0], 7, "after release the session is told again");
  assert.equal(w.length, 7);
});

test("id 0 and growth", () => {
  const n = 5000;
  const ids = new BigUint64Array(n); for (let i = 0; i < n; i++) ids[i] = BigInt(i);
  const desc = Int32Array.from([9, 0, 1, 0, 0]);
  const cnt = new Int32Array(1);
  fanout.selectNames(Int32Array.from([0]), Int32Array.from([n]), ids, desc, desc.length, new BigUint64Array(0), cnt);
  assert.equal(cnt[0], n);
  fanout.selectNames(Int32Array.from([0]), Int32Array.from([n]), ids, desc, desc.length, new BigUint64Array(0), cnt);
  assert.equal(cnt[0], 0);
});
