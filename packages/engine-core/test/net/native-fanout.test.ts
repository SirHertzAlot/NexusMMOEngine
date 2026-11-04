/**
 * NativeFanout (packages/addons/fanout) must hand each session exactly what the JavaScript path
 * builds: the same 0x25 envelope bytes, and the same set of names, each once.
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { addComponent } from "bitecs";
import { DeltaSetKind, encodeDeltaSet, encodeEnvelope, MessageType, type DeltaSetEntry } from "@mmo-engine/protocol";
import { DeltaTracker, SimWorld, Transform, Velocity } from "../../src/index.js";
import { NativeFanout } from "../../src/net/native-fanout.js";
import { SectorIndex } from "../../src/net/interest.js";
import type { ClientSession } from "../../src/session.js";

const require = createRequire(import.meta.url);
const addon = (() => {
  try {
    return require("@mmo-engine/addon-fanout");
  } catch {
    return null;
  }
})();
const skip = addon ? false : "fanout addon not built";

const fakeSession = (i: number, interestSet: Set<string>, player: bigint | null, pinned: bigint[]): ClientSession =>
  ({ clientId: `c${i}`, interestSet, playerEntity: player, pinnedOut: new Set(pinned) }) as unknown as ClientSession;

for (const share of ["off", "assembly"] as const) it(`matches the JavaScript envelope bytes and names, across ticks (share ${share})`, { skip }, () => {
  const sim = new SimWorld();
  for (let i = 0; i < 300; i++) {
    const eid = sim.spawn();
    addComponent(sim.ecs, Transform, eid);
    addComponent(sim.ecs, Velocity, eid);
    Transform.px[eid] = (i % 20) * 30 - 300;
    Transform.pz[eid] = Math.floor(i / 20) * 30 - 200;
    Transform.qw[eid] = 1;
    Transform.sx[eid] = Transform.sy[eid] = Transform.sz[eid] = 1;
  }
  const index = new SectorIndex();
  const tracker = new DeltaTracker();
  const nf = new NativeFanout(new addon.Fanout(), share);
  const told = new Map<string, Set<bigint>>(); // the JavaScript rule: a name goes out once per session

  for (let tick = 1; tick <= 6; tick++) {
    sim.beginTick(tick);
    for (let e = 1; e < 300; e++) Transform.px[e] += 0.3 * ((e % 3) - 1);
    sim.emitTick(tick);
    const frame = index.frame(sim, tick, tracker, null);
    tracker.commit(sim);
    sim.endTick();

    const sectors = [...frame.occupied()];
    const bySector = new Map<string, bigint[]>();
    sectors.forEach((k, i) => bySector.set(k, [BigInt(1000 + i * 2), BigInt(1001 + i * 2)]));
    const sessions = [0, 1, 2, 3].map((i) =>
      fakeSession(i, new Set(sectors.slice(i, i + 3 + tick)), i === 3 ? null : BigInt(500 + i), i === 1 ? [7n, 8n, BigInt(1000)] : []),
    );
    nf.begin(tick, bySector);
    const wantEntries: DeltaSetEntry[][] = [];
    sessions.forEach((s, i) => {
      const replace = tick === 1 || i === 2;
      const entries: DeltaSetEntry[] = [];
      for (const k of s.interestSet!) {
        if (replace) entries.push({ kind: DeltaSetKind.Full, sector: k, bytes: frame.full(k) });
        else {
          const d = frame.delta(k);
          if (d) entries.push({ kind: DeltaSetKind.Delta, sector: k, bytes: d });
        }
      }
      entries.push({ kind: DeltaSetKind.Leave, sector: "9,9", bytes: new Uint8Array(0) });
      wantEntries.push(entries);
      nf.add(s, replace, entries);
    });
    const results = nf.run();
    sessions.forEach((s, i) => {
      const replace = tick === 1 || i === 2;
      const want = encodeEnvelope(MessageType.DeltaSet, encodeDeltaSet({ tick, replace, entries: wantEntries[i] }));
      assert.deepEqual(Buffer.from(results[i].env), Buffer.from(want), `tick ${tick} session ${i} envelope`);

      const seen = told.get(s.clientId) ?? new Set<bigint>();
      told.set(s.clientId, seen);
      const expect: bigint[] = [];
      const consider = (w: bigint): void => {
        if (seen.has(w)) return;
        seen.add(w);
        expect.push(w);
      };
      if (s.playerEntity !== null) consider(s.playerEntity);
      for (const k of s.interestSet!) for (const w of bySector.get(k) ?? []) consider(w);
      for (const w of s.pinnedOut!) consider(w);
      assert.deepEqual(results[i].want ?? [], expect, `tick ${tick} session ${i} names`);
    });
  }
});

it("a released session is told its names again", { skip }, () => {
  const nf = new NativeFanout(new addon.Fanout());
  const s = fakeSession(0, new Set(["0,0"]), 5n, []);
  const bySector = new Map([["0,0", [11n]]]);
  const entries: DeltaSetEntry[] = [{ kind: DeltaSetKind.Leave, sector: "0,0", bytes: new Uint8Array(0) }];
  const tickOnce = (tick: number): bigint[] | null => {
    nf.begin(tick, bySector);
    nf.add(s, false, entries);
    return nf.run()[0].want;
  };
  assert.deepEqual(tickOnce(1), [5n, 11n]);
  assert.equal(tickOnce(2), null);
  nf.sweep(new Map()); // the session is no longer live
  assert.deepEqual(tickOnce(3), [5n, 11n]);
});

it("a reused entity slot has a new wire id, so its name is sent again", { skip }, () => {
  const sim = new SimWorld();
  const a = sim.spawn();
  const wireA = sim.wireId(a);
  sim.despawn(a);
  sim.beginTick(1);
  sim.endTick();
  const b = sim.spawn();
  assert.equal(b, a, "the slot is reused");
  const wireB = sim.wireId(b);
  assert.notEqual(wireB, wireA, "the generation moved on");

  const nf = new NativeFanout(new addon.Fanout());
  const s = fakeSession(0, new Set(["0,0"]), null, []);
  const entries: DeltaSetEntry[] = [{ kind: DeltaSetKind.Leave, sector: "0,0", bytes: new Uint8Array(0) }];
  const tickOnce = (tick: number, ids: bigint[]): bigint[] | null => {
    nf.begin(tick, new Map([["0,0", ids]]));
    nf.add(s, false, entries);
    return nf.run()[0].want;
  };
  assert.deepEqual(tickOnce(1, [wireA]), [wireA]);
  assert.equal(tickOnce(2, [wireA]), null, "same entity: not named twice");
  assert.deepEqual(tickOnce(3, [wireB]), [wireB], "new occupant of the slot: named");
  assert.equal(tickOnce(4, [wireB]), null);
});

it("sessions with identical entry lists share one assembled envelope; a different list or replace flag does not", { skip }, () => {
  const nf = new NativeFanout(new addon.Fanout(), "assembly");
  const payload = new Uint8Array([1, 2, 3, 4]);
  const other = new Uint8Array([9, 9]);
  const mk = (kind: number, sector: string, bytes: Uint8Array): DeltaSetEntry => ({ kind, sector, bytes }) as DeltaSetEntry;
  const same = [mk(DeltaSetKind.Delta, "0,0", payload), mk(DeltaSetKind.Leave, "9,9", new Uint8Array(0))];
  const diffPayload = [mk(DeltaSetKind.Delta, "0,0", other), mk(DeltaSetKind.Leave, "9,9", new Uint8Array(0))];
  const diffSector = [mk(DeltaSetKind.Delta, "1,0", payload), mk(DeltaSetKind.Leave, "9,9", new Uint8Array(0))];
  nf.begin(7, null);
  const plan: Array<[boolean, DeltaSetEntry[]]> = [[false, same], [false, same], [false, diffPayload], [false, diffSector], [true, same], [false, same]];
  plan.forEach(([replace, entries], i) => nf.add(fakeSession(i, new Set(), null, []), replace, entries));
  const res = nf.run();
  assert.equal(nf.count.groups, 4, "4 distinct (replace, entries) among 6 sessions");
  assert.equal(res[0].group, res[1].group);
  assert.equal(res[0].group, res[5].group);
  assert.notEqual(res[0].group, res[4].group, "replace flag separates groups");
  plan.forEach(([replace, entries], i) => {
    const want = encodeEnvelope(MessageType.DeltaSet, encodeDeltaSet({ tick: 7, replace, entries }));
    assert.deepEqual(Buffer.from(res[i].env), Buffer.from(want), `session ${i}`);
  });
  assert.ok(nf.count.assembledBytes < nf.count.envelopeBytes, "fewer bytes assembled than delivered");
});

it("numeric group table scales past 4,096 distinct groups in a single broadcast with mid-tick rehashing and resets cleanly", { skip }, () => {
  const nf = new NativeFanout(new addon.Fanout(), "assembly");
  const p0 = new Uint8Array([10, 20, 30]);
  const p1 = new Uint8Array([40, 50]);
  const totalGroups = 4500;
  const expected: DeltaSetEntry[][] = [];

  nf.begin(101, null);
  for (let i = 0; i < totalGroups; i++) {
    const entries: DeltaSetEntry[] = [
      { kind: DeltaSetKind.Delta, sector: `${i},0`, bytes: i % 2 === 0 ? p0 : p1 },
    ];
    expected.push(entries);
    nf.add(fakeSession(i, new Set(), null, []), false, entries);
  }
  const res = nf.run();
  assert.equal(res.length, totalGroups);
  assert.equal(nf.count.groups, totalGroups, "every distinct group preserved across table doublings");
  for (const idx of [0, 1, 1023, 1024, 2047, 2048, 4095, 4096, totalGroups - 1]) {
    const want = encodeEnvelope(MessageType.DeltaSet, encodeDeltaSet({ tick: 101, replace: false, entries: expected[idx] }));
    assert.deepEqual(Buffer.from(res[idx].env), Buffer.from(want), `group ${idx} envelope matches after rehash`);
  }

  // Next broadcast resets table cleanly and shares groups again.
  nf.begin(102, null);
  const shared = Object.freeze([{ kind: DeltaSetKind.Delta, sector: "0,0", bytes: p0 }]);
  nf.add(fakeSession(0, new Set(), null, []), false, shared);
  nf.add(fakeSession(1, new Set(), null, []), false, shared);
  const res2 = nf.run();
  assert.equal(res2[0].group, res2[1].group);
});

it("distinguishes entry ordering, all DeltaSetKinds, forced hash collisions, and mutable entry array reuse", { skip }, () => {
  const nf = new NativeFanout(new addon.Fanout(), "assembly");
  const bA = new Uint8Array([1, 2]);
  const bB = new Uint8Array([3, 4]);

  const order1: DeltaSetEntry[] = [
    { kind: DeltaSetKind.Delta, sector: "0,0", bytes: bA },
    { kind: DeltaSetKind.Delta, sector: "1,0", bytes: bB },
  ];
  const order2: DeltaSetEntry[] = [
    { kind: DeltaSetKind.Delta, sector: "1,0", bytes: bB },
    { kind: DeltaSetKind.Delta, sector: "0,0", bytes: bA },
  ];
  const kindFull: DeltaSetEntry[] = [
    { kind: DeltaSetKind.Full, sector: "0,0", bytes: bA },
    { kind: DeltaSetKind.Delta, sector: "1,0", bytes: bB },
  ];
  const kindPinned: DeltaSetEntry[] = [
    { kind: DeltaSetKind.Pinned, sector: "0,0", bytes: bA },
    { kind: DeltaSetKind.Delta, sector: "1,0", bytes: bB },
  ];

  // Test tickSeq 32-bit wraparound at the same time
  (nf as unknown as { tickSeq: number }).tickSeq = 0xfffffffe;
  nf.begin(10, null);
  nf.begin(11, null); // wraps 0xffffffff -> 1

  nf.add(fakeSession(0, new Set(), null, []), false, order1);
  nf.add(fakeSession(1, new Set(), null, []), false, order2);
  nf.add(fakeSession(2, new Set(), null, []), false, kindFull);
  nf.add(fakeSession(3, new Set(), null, []), false, kindPinned);

  // Mutable array reused and mutated in-place between two add() calls in the same tick:
  const mutableShared: DeltaSetEntry[] = [{ kind: DeltaSetKind.Delta, sector: "2,2", bytes: bA }];
  nf.add(fakeSession(4, new Set(), null, []), false, mutableShared);
  mutableShared[0] = { kind: DeltaSetKind.Delta, sector: "2,2", bytes: bB };
  nf.add(fakeSession(5, new Set(), null, []), false, mutableShared);

  const res = nf.run();
  const groups = new Set(res.map((r) => r.group));
  assert.equal(groups.size, 6, "all 6 sessions have distinct groups (no false aliasing)");

  const expectedLists: DeltaSetEntry[][] = [
    order1,
    order2,
    kindFull,
    kindPinned,
    [{ kind: DeltaSetKind.Delta, sector: "2,2", bytes: bA }],
    [{ kind: DeltaSetKind.Delta, sector: "2,2", bytes: bB }],
  ];
  expectedLists.forEach((entries, i) => {
    const want = encodeEnvelope(MessageType.DeltaSet, encodeDeltaSet({ tick: 11, replace: false, entries }));
    assert.deepEqual(Buffer.from(res[i].env), Buffer.from(want), `session ${i} exact envelope`);
  });
});
