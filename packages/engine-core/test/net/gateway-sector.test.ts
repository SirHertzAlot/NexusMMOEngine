/**
 * Gateway sector fan-out (Phase 5, Part A): per-tick deltas reach every
 * welcomed client through sector-topic publish, byte-identical to the
 * per-socket path — including after a client crosses a sector
 * boundary — and disabling sector broadcast keeps the old path
 * delivering the same bytes.
 *
 * Race discipline (as in gateway.test.ts): every waitFor() is armed
 * BEFORE the frames() that produce the messages.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  MessageType,
  PROTOCOL_VERSION,
} from "@mmo-engine/protocol";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import { sectorOf, sectorTopicFor } from "../../src/net/sector.js";
import {
  decodeDelta,
  decodeSnapshot,
  type CollectedState,
} from "../../src/snapshot.js";
import { applyTeleport } from "../../src/admin/player.js";
import { HeadlessClient, type HelloAuth } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

const STEP_MS = 1000 / 30;

let now = 0;
let gw: Gateway | null = null;

async function startGateway(opts: GatewayOptions = {}): Promise<string> {
  now = 1_000_000;
  gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    ...opts,
  });
  const port = await gw.listen();
  gw.frame(now);
  return `ws://127.0.0.1:${port}`;
}

function frames(n: number): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    gw!.frame(now);
  }
}

const creds = (username: string): HelloAuth => ({
  username,
  password: TEST_PASSWORD,
});

async function connectHello(url: string, name: string): Promise<{ client: HeadlessClient; entity: bigint; snapshot: CollectedState }> {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  const welcome = await client.hello(name, creds(name));
  assert.equal(welcome.protocol, PROTOCOL_VERSION);
  const [snapPayload] = await snapP;
  return { client, entity: BigInt(welcome.player_entity), snapshot: decodeSnapshot(snapPayload) };
}

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

describe("gateway sector fan-out (Phase 5)", () => {
  it("sector helpers: grid cells and topic names", () => {
    assert.deepEqual(sectorOf(0, 0), { sx: 0, sz: 0 });
    assert.deepEqual(sectorOf(63.9, -0.1), { sx: 0, sz: -1 });
    assert.deepEqual(sectorOf(64, 128), { sx: 1, sz: 2 });
    assert.deepEqual(sectorOf(-1, -65), { sx: -1, sz: -2 });
    assert.equal(sectorTopicFor(0, 0), "sector:0,0");
    assert.equal(sectorTopicFor(1000, -500), "sector:15,-8");
  });

  it("publishes deltas to every client, byte-identical across sectors", async () => {
    const url = await startGateway();
    const alice = await connectHello(url, "alice");
    const bob = await connectHello(url, "user-a");
    // Bob starts in the same sector as Alice; move him to a far sector
    // so the two clients sit on different topics.
    assert.equal(applyTeleport(gw!.world, bob.entity, 1000, -500, null).ok, true);

    const aliceDeltas = alice.client.waitFor(MessageType.Delta, 3);
    const bobDeltas = bob.client.waitFor(MessageType.Delta, 3);
    frames(3);
    const aPayloads = await aliceDeltas;
    const bPayloads = await bobDeltas;

    // Same ticks, same bytes: publish changes fan-out, not content.
    const byTick = (payloads: Uint8Array[]): Map<number, Uint8Array> => {
      const m = new Map<number, Uint8Array>();
      for (const p of payloads) m.set(decodeDelta(p).tick, p);
      return m;
    };
    const aByTick = byTick(aPayloads);
    const bByTick = byTick(bPayloads);
    assert.ok(aByTick.size > 0 && bByTick.size > 0);
    for (const [tick, payload] of aByTick) {
      const other = bByTick.get(tick);
      assert.ok(other, `bob also got tick ${tick}`);
      assert.deepEqual([...payload], [...other!], `tick ${tick} bytes identical across sectors`);
    }
  });

  it("keeps delivering after a client crosses a sector boundary", async () => {
    const url = await startGateway();
    const bob = await connectHello(url, "user-b");
    const first = bob.client.waitFor(MessageType.Delta, 2);
    frames(2);
    assert.equal((await first).length, 2);

    // Cross from sector (0,0) into sector (15,-8): the gateway must
    // re-subscribe the session, not strand it on the old topic.
    assert.equal(applyTeleport(gw!.world, bob.entity, 1000, -500, null).ok, true);
    const second = bob.client.waitFor(MessageType.Delta, 3);
    frames(3);
    assert.equal((await second).length, 3);
  });

  it("sectorBroadcast:false delivers the same deltas via per-socket sends", async () => {
    const url = await startGateway({ sectorBroadcast: false });
    const alice = await connectHello(url, "alice");
    const bob = await connectHello(url, "user-a");
    const aliceDeltas = alice.client.waitFor(MessageType.Delta, 2);
    const bobDeltas = bob.client.waitFor(MessageType.Delta, 2);
    frames(2);
    const aPayloads = await aliceDeltas;
    const bPayloads = await bobDeltas;
    assert.equal(aPayloads.length, 2);
    assert.equal(bPayloads.length, 2);
    // Same ticks, same bytes as the publish path would send.
    for (let i = 0; i < 2; i++) {
      assert.equal(decodeDelta(aPayloads[i]).tick, decodeDelta(bPayloads[i]).tick);
      assert.deepEqual([...aPayloads[i]], [...bPayloads[i]]);
    }
  });
});
