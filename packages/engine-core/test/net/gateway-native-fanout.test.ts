/**
 * Native fan-out inside a real Gateway on the uWS transport: a scripted session (interest entry and exit,
 * a dense sector, an empty far sector, a resync baseline, a client that disconnects mid-run, a join that
 * reuses a freed slot) with the native path shadowed in place. Every envelope it produces is compared with
 * the JavaScript encoder on the same entries, and every name list with the JavaScript "named once" rule.
 * Also: which path is active is observable, MMO_NATIVE_FANOUT=0 selects JS, an unavailable addon falls
 * back to JS with the reason, and a failing addon finishes the tick in JS without losing it.
 */
import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { encodeDeltaSet, encodeEnvelope, MessageType, type DeltaSetEntry } from "@mmo-engine/protocol";
import type { ClientSession } from "../../src/session.js";
import { Gateway } from "../../src/net/gateway.js";
import { applyTeleport } from "../../src/admin/player.js";
import { loadNativeFanout, NativeFanout } from "../../src/net/native-fanout.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

const STEP_MS = 1000 / 30;
let gw: Gateway | null = null;
afterEach(async () => {
  await gw?.close();
  gw = null;
  delete process.env.MMO_NATIVE_FANOUT;
});

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

interface Run {
  streams: Map<string, string[]>;
  status: Gateway["fanoutStatus"];
  ticks: { native: number; js: number };
  /** Native envelopes and name lists compared against the JavaScript rule on the same inputs, in the same tick. */
  checked: { envelopes: number; nameLists: number; mismatches: string[] };
}

/**
 * Shadow the native path inside the live Gateway: every envelope it returns is compared with
 * encodeEnvelope(encodeDeltaSet(entries)) built from the very entries it was given, and every name
 * list with the JavaScript "named once per session" rule. Same state, same tick: no run-to-run noise.
 */
function shadow(nf: NativeFanout): Run["checked"] {
  const checked: Run["checked"] = { envelopes: 0, nameLists: 0, mismatches: [] };
  const o = nf as unknown as {
    begin: NativeFanout["begin"];
    add: NativeFanout["add"];
    run: NativeFanout["run"];
  };
  const begin = o.begin.bind(nf), add = o.add.bind(nf), run = o.run.bind(nf);
  let tickNo = 0;
  let table: ReadonlyMap<string, bigint[]> | null = null;
  let queued: Array<{ s: ClientSession; replace: boolean; entries: readonly DeltaSetEntry[]; sectors: string[]; pins: bigint[] }> = [];
  const told = new Map<string, Set<bigint>>();
  o.begin = (tick, bySector) => {
    tickNo = tick;
    table = bySector;
    queued = [];
    begin(tick, bySector);
  };
  o.add = (s, replace, entries) => {
    queued.push({ s, replace, entries: [...entries], sectors: [...(s.interestSet ?? [])], pins: [...(s.pinnedOut ?? [])] });
    add(s, replace, entries);
  };
  o.run = () => {
    const results = run();
    queued.forEach((q, i) => {
      const want = encodeEnvelope(MessageType.DeltaSet, encodeDeltaSet({ tick: tickNo, replace: q.replace, entries: q.entries as DeltaSetEntry[] }));
      checked.envelopes++;
      if (Buffer.compare(Buffer.from(results[i].env), Buffer.from(want)) !== 0) checked.mismatches.push(`tick ${tickNo} ${q.s.username}: envelope bytes differ`);
      if (table) {
        const seen = told.get(q.s.clientId) ?? new Set<bigint>();
        told.set(q.s.clientId, seen);
        const expect: bigint[] = [];
        const consider = (w: bigint): void => {
          if (seen.has(w)) return;
          seen.add(w);
          expect.push(w);
        };
        if (q.s.playerEntity !== null) consider(q.s.playerEntity);
        for (const k of q.sectors) for (const w of table.get(k) ?? []) consider(w);
        for (const w of q.pins) consider(w);
        checked.nameLists++;
        if (JSON.stringify((results[i].want ?? []).map(String)) !== JSON.stringify(expect.map(String))) {
          checked.mismatches.push(`tick ${tickNo} ${q.s.username}: names [${results[i].want ?? []}] vs [${expect}]`);
        }
      }
    });
    return results;
  };
  return checked;
}

async function scenario(mode: "default" | "off" | "break"): Promise<Run> {
  if (mode === "off") process.env.MMO_NATIVE_FANOUT = "0";
  else delete process.env.MMO_NATIVE_FANOUT;
  let now = 1_000_000;
  const g = (gw = new Gateway({ clock: () => now, credentialStore: await makeCredentialStore(), transport: "uws", interest: { enterM: 96, leaveM: 128 } }));
  const nfInstance = (g as unknown as { fanout: NativeFanout | null }).fanout;
  let checked: Run["checked"] = { envelopes: 0, nameLists: 0, mismatches: [] };
  if (mode === "default" && nfInstance) checked = shadow(nfInstance);
  if (mode === "break") {
    // The addon throws on its first call: the tick must still go out, in JavaScript.
    nfInstance!.run = () => {
      throw new Error("simulated addon failure");
    };
  }
  const url = `ws://127.0.0.1:${await g.listen()}`;
  g.frame(now);
  const frames = async (n: number, clients: HeadlessClient[]): Promise<void> => {
    const waits = clients.map((c) => c.waitFor(MessageType.DeltaSet, n));
    for (let i = 0; i < n; i++) {
      now += STEP_MS;
      g.frame(now);
    }
    await Promise.all(waits);
  };
  const join = async (name: string): Promise<{ c: HeadlessClient; id: bigint }> => {
    const c = new HeadlessClient();
    await c.connect(url);
    const w = await c.hello(name, { username: name, password: TEST_PASSWORD });
    return { c, id: BigInt(String(w.player_entity)) };
  };
  const tp = (id: bigint, x: number, z: number): void => {
    assert.equal(applyTeleport(g.world, id, x, z, null).ok, true);
  };

  const a = await join("alice");
  const b = await join("user-a");
  const c = await join("user-b");
  const d = await join("user-c");
  tp(a.id, 0, 0);
  tp(b.id, 30, 0); // dense with alice
  tp(c.id, 40, 10); // dense with alice
  tp(d.id, 1500, 1500); // alone, far: an empty neighbourhood
  await frames(4, [a.c, b.c, c.c, d.c]);
  tp(c.id, 400, 400); // c leaves a's and b's interest
  await frames(4, [a.c, b.c, c.c, d.c]);
  tp(c.id, 20, 20); // and comes back
  await frames(4, [a.c, b.c, c.c, d.c]);
  // A resync: the next tick is a replace baseline for b.
  const sessions = [...(g as unknown as { sessions: Map<string, { playerEntity: bigint | null; needsResync: boolean }> }).sessions.values()];
  sessions.find((s) => s.playerEntity === b.id)!.needsResync = true;
  await frames(3, [a.c, b.c, c.c, d.c]);
  // b disconnects mid-run; frames keep going while its socket closes.
  await b.c.close();
  await frames(3, [a.c, c.c, d.c]);
  // A new player joins (the freed slot may be reused) next to alice.
  const e = await join("zombie");
  tp(e.id, 10, 10);
  await frames(5, [a.c, c.c, d.c, e.c]);
  // The player count never changes what a session is told about itself: despawn one more, keep ticking.
  await d.c.close();
  await frames(3, [a.c, c.c, e.c]);

  const streams = new Map<string, string[]>();
  for (const [name, cl] of [["a", a.c], ["b", b.c], ["c", c.c], ["d", d.c], ["e", e.c]] as const) {
    for (const type of [MessageType.DeltaSet, MessageType.Names] as const) {
      streams.set(`${name}:${type}`, cl.payloads(type).map(hex));
    }
  }
  const out = { streams, status: g.fanoutStatus, ticks: { ...g.fanoutTicks }, checked };
  await Promise.all([a.c, c.c, e.c].map((x) => x.close()));
  await g.close();
  gw = null;
  return out;
}

it("native fan-out equals the JavaScript rule on every envelope and name list, through a real Gateway", async () => {
  const native = await scenario("default");
  if (native.status.path !== "native") return; // addon not built here
  assert.ok(native.ticks.native > 20, `native path ran ${native.ticks.native} ticks`);
  assert.ok(native.checked.envelopes > 50, `${native.checked.envelopes} envelopes compared`);
  assert.ok(native.checked.nameLists > 50);
  assert.deepEqual(native.checked.mismatches, []);
  const named = [...native.streams.entries()].filter(([k]) => k.endsWith(`:${MessageType.Names}`)).reduce((n, [, v]) => n + v.length, 0);
  assert.ok(named > 0, "the script exercises names");
});

it("MMO_NATIVE_FANOUT=0 selects the JavaScript path and says so", async () => {
  const js = await scenario("off");
  assert.equal(js.status.path, "js");
  assert.match(js.status.reason, /MMO_NATIVE_FANOUT=0/);
  assert.equal(js.ticks.native, 0);
  assert.ok(js.ticks.js > 20);
});

it("a failing addon finishes the tick in JavaScript, then stays on JavaScript", async () => {
  const broke = await scenario("break");
  if (broke.ticks.native === 0 && broke.status.reason.startsWith("addon unavailable")) return; // addon not built
  assert.equal(broke.status.path, "js");
  assert.match(broke.status.reason, /native call failed: simulated addon failure/);
  assert.ok(broke.ticks.js > 20);
  // Every client still got its stream: the failing tick was not dropped.
  for (const [k, v] of broke.streams) if (k.endsWith(`:${MessageType.DeltaSet}`)) assert.ok(v.length >= 3, `stream ${k} has ${v.length} DeltaSets`);
});

it("an unavailable or incompatible addon falls back to JavaScript with the reason", () => {
  const missing = loadNativeFanout(() => {
    throw new Error("addon-fanout: native binding not found");
  });
  assert.equal(missing.fanout, null);
  assert.equal(missing.status.path, "js");
  assert.match(missing.status.reason, /addon unavailable: addon-fanout: native binding not found/);
  delete process.env.MMO_NATIVE_FANOUT;
  const ok = loadNativeFanout(() => ({ version: () => "9.9.9", Fanout: class {} }) as never);
  assert.equal(ok.status.path, "native");
  assert.match(ok.status.reason, /9\.9\.9/);
});
