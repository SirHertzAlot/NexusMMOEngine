import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { encodeDeltaSet, encodeEnvelope, MessageType, DeltaSetKind } from "@mmo-engine/protocol";

const require = createRequire(import.meta.url);
const { Fanout } = require("../index.js");
let fanout = new Fanout();

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

test("two Fanout objects keep separate name tables and sent sets", () => {
  const a = new Fanout(), b = new Fanout();
  a.setName(0, new TextEncoder().encode("a-sector"));
  b.setName(0, new TextEncoder().encode("b"));
  const payloads = [rnd(4, 9)];
  const desc = Int32Array.from([1, 0, 1, 0, 0]);
  const arenaA = new Uint8Array(64), arenaB = new Uint8Array(64), out = new Int32Array(2);
  a.assemble(7, arenaA, out, desc, desc.length, payloads);
  const lenA = out[1];
  b.assemble(7, arenaB, out, desc, desc.length, payloads);
  assert.equal(lenA - out[1], "a-sector".length - 1);
  // the same slot in two objects: naming one does not mark the other
  const nd = Int32Array.from([3, 0, 1, 0, 0]);
  const cnt = new Int32Array(1);
  const args = [Int32Array.from([0]), Int32Array.from([1]), BigUint64Array.from([42n]), nd, nd.length, new BigUint64Array(0), cnt];
  assert.equal(a.selectNames(...args), 1);
  assert.equal(b.selectNames(...args), 1, "b still has to name 42");
});

test("selectNames skips a sector it already scanned at the same content, and names a new id once", () => {
  const f = new Fanout();
  const cnt = new Int32Array(1);
  const run = (lists, sectors, slot = 1) => {
    const flat = [], start = [], len = [];
    for (const l of lists) { start.push(flat.length); len.push(l.length); flat.push(...l); }
    const desc = Int32Array.from([slot, 0, sectors.length, 0, ...sectors]);
    const n = f.selectNames(Int32Array.from(start), Int32Array.from(len), BigUint64Array.from(flat), desc, desc.length, new BigUint64Array(0), cnt);
    const w = new BigUint64Array(n); f.takeWanted(w); return [...w];
  };
  assert.deepEqual(run([[1n, 2n], [3n]], [0, 1]), [1n, 2n, 3n]);
  assert.deepEqual(run([[1n, 2n], [3n]], [0, 1]), [], "unchanged: nothing, and no rescan needed");
  assert.deepEqual(run([[2n, 1n], [3n]], [0, 1]), [], "same ids in another order: nothing");
  assert.deepEqual(run([[1n, 2n, 9n], [3n]], [0, 1]), [9n], "a new id is named once");
  assert.deepEqual(run([[1n, 2n], [3n]], [0, 1]), [], "an id that left is not re-sent");
  assert.deepEqual(run([[1n, 2n, 9n], [3n]], [0, 1]), [], "and coming back is not re-sent either (the session was told)");
  assert.deepEqual(run([[1n, 2n, 9n], [3n]], [0, 1], 2), [1n, 2n, 9n, 3n], "another session has its own state");
  f.release(1);
  assert.deepEqual(run([[1n]], [0]), [1n], "after release the session starts over");
});

test("selectNames: a session current as of last call only looks at new ids; a stale one rescans in full", () => {
  const f = new Fanout();
  const cnt = new Int32Array(1);
  const run = (lists, sectors, slot) => {
    const flat = [], start = [], len = [];
    for (const l of lists) { start.push(flat.length); len.push(l.length); flat.push(...l); }
    const desc = Int32Array.from([slot, 0, sectors.length, 0, ...sectors]);
    const n = f.selectNames(Int32Array.from(start), Int32Array.from(len), BigUint64Array.from(flat), desc, desc.length, new BigUint64Array(0), cnt);
    const w = new BigUint64Array(n); f.takeWanted(w); return [...w];
  };
  assert.deepEqual(run([[1n, 2n]], [0], 1), [1n, 2n]);
  assert.deepEqual(run([[1n, 2n]], [0], 2), [1n, 2n]);
  // tick 2: id 3 joins; only session 1 is looked at (current as of last call)
  assert.deepEqual(run([[1n, 2n, 3n]], [0], 1), [3n]);
  // tick 3: session 2 was absent last tick, so it is stale: it must still get 3n (and not 1n, 2n again)
  assert.deepEqual(run([[1n, 2n, 3n, 4n]], [0], 2), [3n, 4n]);
  // an id moves in from another sector: it is "added" to this sector for a current session
  assert.deepEqual(run([[1n, 2n, 3n, 4n], [10n]], [0, 1], 3), [1n, 2n, 3n, 4n, 10n]);
  assert.deepEqual(run([[1n, 2n, 3n], [10n, 4n]], [0, 1], 3), [], "4n moved sectors, already told");
  assert.deepEqual(run([[1n, 2n, 3n, 5n], [10n, 4n]], [0, 1], 3), [5n]);
  // a new session joins a sector that has been stable: full list
  assert.deepEqual(run([[1n, 2n, 3n, 5n], [10n, 4n]], [0, 1], 4), [1n, 2n, 3n, 5n, 10n, 4n]);
});

// Hash collisions: with the hash cut to 3 bits, collisions are common. The fast skip can then hide a name
// from a session; the periodic rescan has to bring it back within rescanEvery calls.
function churn(opts, calls, seed) {
  const f = new Fanout(opts);
  let x = seed >>> 0 || 1;
  const rand = (n) => { x = (x * 1664525 + 1013904223) >>> 0; return (x >>> 8) % n; };
  const inSector = new Set();
  const told = new Set();
  const since = new Map(); // id -> first call it was in view and unsent
  let worst = 0;
  const cnt = new Int32Array(1);
  const desc = Int32Array.from([0, 0, 1, 0, 0]);
  for (let c = 0; c < calls; c++) {
    for (let k = 0; k < 3; k++) { const id = BigInt(1 + rand(60)); if (inSector.has(id)) inSector.delete(id); else inSector.add(id); }
    const ids = BigUint64Array.from([...inSector]);
    const n = f.selectNames(Int32Array.from([0]), Int32Array.from([ids.length]), ids, desc, 5, new BigUint64Array(0), cnt);
    const w = new BigUint64Array(n); f.takeWanted(w);
    for (const id of w) { assert.ok(!told.has(id), "never named twice"); told.add(id); since.delete(id); }
    for (const id of inSector) if (!told.has(id) && !since.has(id)) since.set(id, c);
    for (const id of since.keys()) if (inSector.has(id)) worst = Math.max(worst, c - since.get(id));
  }
  return { worst, missing: [...inSector].filter((id) => !told.has(id)).length };
}

test("without the rescan a collision hides a name far longer than the rescan allows", () => {
  const off = churn({ hashBits: 3, rescanEvery: 0 }, 400, 7);
  // Hidden until the id leaves the sector or the session falls out of step; no bound otherwise.
  assert.ok(off.worst > 32, `worst ${off.worst} calls`);
});

test("the rescan bounds how long a collision hides a name", () => {
  for (const every of [8, 32]) {
    const on = churn({ hashBits: 3, rescanEvery: every }, 400, 7);
    assert.ok(on.worst <= every + 1, `rescanEvery ${every}: worst ${on.worst}`);
  }
});

test("full-width hash: no collisions, defaults leave the result unchanged", () => {
  const r = churn({}, 400, 7);
  assert.equal(r.worst, 0, "every name is selected the call it enters view");
});
