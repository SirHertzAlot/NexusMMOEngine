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

it("matches the JavaScript envelope bytes and names, across ticks", { skip }, () => {
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
  const nf = new NativeFanout(new addon.Fanout());
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
