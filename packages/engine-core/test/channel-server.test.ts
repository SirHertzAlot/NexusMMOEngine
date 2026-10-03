/**
 * The core's end of the edge/core channel (E3): a real Gateway serving the
 * channel, a real ChannelClient talking to it.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MessageType } from "@mmo-engine/protocol";
import { ChannelClient } from "@mmo-engine/channel";
import { Gateway } from "../src/net/gateway.js";
import { CORE_METRIC_NAMES, coreChannelPort, isSnapshotTick, pushTick, startCoreChannel, type CoreChannel } from "../src/channel-server.js";
import { SessionManager } from "../src/auth/sessions.js";
import { SqliteSessionStore } from "../src/auth/sqlite-session-store.js";
import { HeadlessClient } from "./net/headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./net/auth-harness.js";

const STEP = 1000 / 30;
let now = 0;
let gw: Gateway | null = null;
let core: CoreChannel | null = null;
let client: ChannelClient | null = null;
const players: HeadlessClient[] = [];

async function start(): Promise<{ gw: Gateway; client: ChannelClient; url: string }> {
  now = 1_000_000;
  gw = new Gateway({ clock: () => now, disconnectGraceMs: 1000, credentialStore: await makeCredentialStore() });
  const port = await gw.listen();
  gw.frame(now);
  core = await startCoreChannel(gw, 0);
  client = new ChannelClient({ port: core.server.port });
  await client.connect();
  return { gw, client, url: `ws://127.0.0.1:${port}` };
}

function tick(n = 1): void {
  for (let i = 0; i < n; i++) { now += STEP; gw!.frame(now); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await sleep(5); }
}

afterEach(async () => {
  for (const p of players.splice(0)) await p.close();
  client?.close(); client = null;
  await core?.close(); core = null;
  await gw?.close(); gw = null;
});

describe("core channel server (E3)", () => {
  it("auth.login issues a token the gateway accepts, then player.intent round-trips", async () => {
    const { client, url } = await start();
    const bad = await client.request("auth.login", { username: "alice", password: "wrong-password" }, "1") as { ok: boolean; reason?: string };
    assert.deepEqual(bad, { ok: false, reason: "auth failed" });
    const login = await client.request("auth.login", { username: "alice", password: TEST_PASSWORD }, "2") as { ok: true; token: string; playerId: string };
    assert.equal(login.ok, true);
    assert.equal(login.playerId, "alice");
    assert.match(login.token, /^[0-9a-f]{64}$/);

    // Before the player is in the world the intent has nowhere to go.
    assert.deepEqual(await client.request("player.intent", { token: "nope", intent: { mx: 1 } }, "3a"), { accepted: false, reason: "no_session", tick: gw!.serverTick });
    const early = await client.request("player.intent", { token: login.token, intent: { mx: 1 } }, "3") as { accepted: boolean; reason: string };
    assert.deepEqual([early.accepted, early.reason], [false, "no_player"]);

    const p = new HeadlessClient(); players.push(p);
    await p.connect(url);
    const snap = p.waitFor(MessageType.Snapshot, 1);
    await p.hello("alice", { token: login.token });
    await snap;

    const r = await client.request("player.intent", { token: login.token, intent: { mx: 1, mz: 0, lookYaw: 0, lookPitch: 0, buttons: 0 } }, "4") as { accepted: boolean; tick: number };
    assert.equal(r.accepted, true);
    assert.ok(Number.isInteger(r.tick) && r.tick >= 0);
    await assert.rejects(client.request("player.intent", { token: login.token, intent: { mx: "x" } }, "5"), /intent\.mx must be a finite number/);
  });

  it("session.validate: bogus token is invalid, a login's token is valid", async () => {
    const { client } = await start();
    assert.deepEqual(await client.request("session.validate", { token: "bogus" }, "1"), { valid: false });
    const login = await client.request("auth.login", { username: "alice", password: TEST_PASSWORD }, "2") as { token: string };
    assert.deepEqual(await client.request("session.validate", { token: login.token }, "3"), { valid: true });
  });

  it("core.sync returns the tick and every live session id", async () => {
    const { client } = await start();
    tick(3);
    const login = await client.request("auth.login", { username: "alice", password: TEST_PASSWORD }, "1") as { token: string };
    const sync = await client.request("core.sync", {}, "2") as { tick: number; sessionIds: string[] };
    assert.ok(Number.isInteger(sync.tick) && sync.tick >= 3);
    assert.deepEqual(sync.sessionIds, [login.token]);
  });

  it("unknown types and unwired mythic packets answer with an error", async () => {
    const { client } = await start();
    await assert.rejects(client.request("no.such.type", {}, "1"), /unknown packet type no\.such\.type/);
    await assert.rejects(client.request("mythic.grant_item", {}, "2"), /not wired/);
    const text = await client.request("metrics.get", {}, "3") as string;
    assert.match(text, /^mmo_core_tick \d+$/m);
  });

  it("pushes tick.events and tick.delta every tick, in order", async () => {
    const { client } = await start();
    const events: number[] = [];
    const deltas: number[] = [];
    client.onPush("tick.events", (p) => events.push((p as { tick: number }).tick));
    client.onPush("tick.delta", (p) => {
      const d = p as { tick: number; delta: string };
      assert.ok(Buffer.from(d.delta, "base64").length > 0);
      deltas.push(d.tick);
    });
    await sleep(20);
    tick(3);
    await until(() => events.length >= 3 && deltas.length >= 3);
    assert.equal(events.length, 3);
    assert.ok(events[1] === events[0] + 1 && events[2] === events[1] + 1);
    assert.deepEqual(deltas, events);
  });
});

describe("snapshot cadence", () => {
  it("isSnapshotTick: 0 and multiples of 300", () => {
    assert.equal(isSnapshotTick(0), true);
    assert.equal(isSnapshotTick(1), false);
    assert.equal(isSnapshotTick(299), false);
    assert.equal(isSnapshotTick(300), true);
  });

  it("pushes a snapshot only on snapshot ticks", () => {
    for (const t of [299, 300, 301]) {
      const types: string[] = [];
      let built = 0;
      pushTick((type) => types.push(type), {
        tick: t, delta: new Uint8Array([1]), events: [],
        fullState: () => { built++; return new Uint8Array([2]); },
      });
      assert.deepEqual(types, t === 300 ? ["tick.events", "tick.delta", "snapshot"] : ["tick.events", "tick.delta"]);
      assert.equal(built, t === 300 ? 1 : 0);
    }
  });

  it("CORE_CHANNEL_PORT defaults to 4000 and rejects junk naming the var", () => {
    assert.equal(coreChannelPort({}), 4000);
    assert.equal(coreChannelPort({ CORE_CHANNEL_PORT: "4100" }), 4100);
    assert.throws(() => coreChannelPort({ CORE_CHANNEL_PORT: "abc" }), /CORE_CHANNEL_PORT/);
  });
});

describe("SQLite session store", () => {
  it("sessions survive a restart; revoked and expired ones do not", () => {
    const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mmo-sessions-")), "world.db");
    let t = 1000;
    const clock = () => t;
    const store1 = new SqliteSessionStore(db);
    const m1 = new SessionManager({ ttlMs: 500, clock, store: store1 });
    const kept = m1.create("c1", "alice");
    const revoked = m1.create("c2", "bob");
    m1.revoke(revoked);
    store1.close();

    const store2 = new SqliteSessionStore(db);
    const m2 = new SessionManager({ ttlMs: 500, clock, store: store2 });
    assert.equal(m2.get(kept)?.username, "alice");
    assert.equal(m2.get(revoked), null);
    assert.deepEqual(m2.tokens(), [kept]);
    store2.close();

    t += 1000; // past the TTL
    const store3 = new SqliteSessionStore(db);
    const m3 = new SessionManager({ ttlMs: 500, clock, store: store3 });
    assert.equal(m3.get(kept), null);
    assert.equal(m3.size(), 0);
    store3.close();
  });
});

describe("core metrics (E6)", () => {
  it("metrics.get answers the core registry: tick time, pushes, intents and the channel's core side", async () => {
    const { client } = await start();
    tick(5);
    await client.request("player.intent", { token: "nobody", intent: {} }, "1"); // refused: not counted as accepted
    const text = await client.request("metrics.get", {}, "2") as string;
    for (const name of CORE_METRIC_NAMES) assert.match(text, new RegExp(`^# TYPE ${name} `, "m"), name);
    const count = Number(/^mmo_core_tick_duration_ms_count (\d+)$/m.exec(text)![1]);
    assert.ok(count >= 5, `tick_duration_ms_count ${count}`);
    assert.match(text, /^mmo_core_tick_events_pushed_total ([5-9]|\d\d+)$/m);
    assert.match(text, /^mmo_core_intents_accepted_total 0$/m);
    assert.match(text, /^mmo_core_tick_duration_ms_bucket\{le="33\.3"\} \d+$/m);
    // The request being answered is counted once it is in flight.
    assert.match(text, /^mmo_channel_requests_total\{side="core"\} 2$/m);
    assert.match(text, /^mmo_channel_pushes_total\{side="core",type="tick\.delta"\} \d+$/m);
    assert.match(text, /^mmo_core_tick \d+$/m);
  });
});
