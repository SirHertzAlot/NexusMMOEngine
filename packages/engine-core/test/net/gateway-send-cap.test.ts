/**
 * Send-rate cap (opt-in, MMO_SEND_CAP_BYTES): a quiet session is sent to every second tick, the send after a skip
 * carries a two-tick window, and the viewer's mirror never lags the server by more than one tick of movement and
 * converges exactly on the catch-up send. Without the flag every tick is sent.
 */
import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { decodeDelta, decodeDeltaSet, DeltaSetKind, MessageType } from "@mmo-engine/protocol";
import { MirrorState } from "@mmo-engine/mirror";
import { Gateway } from "../../src/net/gateway.js";
import { applyTeleport } from "../../src/admin/player.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

const STEP_MS = 1000 / 30;
let now = 0;
let gw: Gateway | null = null;
const prevCap = process.env.MMO_SEND_CAP_BYTES;

afterEach(async () => {
  await gw?.close();
  gw = null;
  if (prevCap === undefined) delete process.env.MMO_SEND_CAP_BYTES;
  else process.env.MMO_SEND_CAP_BYTES = prevCap;
});

async function run(cap: string | undefined) {
  if (cap === undefined) delete process.env.MMO_SEND_CAP_BYTES;
  else process.env.MMO_SEND_CAP_BYTES = cap;
  now = 1_000_000;
  gw = new Gateway({ clock: () => now, credentialStore: await makeCredentialStore(), interest: { enterM: 96, leaveM: 128 } });
  const url = `ws://127.0.0.1:${await gw.listen()}`;
  gw.frame(now);
  const watcher = new HeadlessClient();
  await watcher.connect(url);
  const wWelcome = await watcher.hello("alice", { username: "alice", password: TEST_PASSWORD });
  const mover = new HeadlessClient();
  await mover.connect(url);
  const mEntity = BigInt((await mover.hello("user-a", { username: "user-a", password: TEST_PASSWORD })).player_entity);
  const mirror = new MirrorState();
  let sets = 0;
  const raw = (watcher as unknown as { ws: { on(ev: string, fn: (...a: never[]) => void): void } }).ws;
  raw.on("message", ((m: Uint8Array) => {
    if (m[0] !== MessageType.DeltaSet) return;
    sets++;
    const set = decodeDeltaSet(m.subarray(1));
    mirror.applyDeltaSet(set.tick, set.replace, set.entries.map((e) => ({
      sector: e.sector,
      leave: e.kind === DeltaSetKind.Leave,
      delta: e.kind === DeltaSetKind.Leave ? null : decodeDelta(e.bytes),
    })));
  }) as (...a: never[]) => void);
  assert.equal(applyTeleport(gw.world, BigInt(wWelcome.player_entity), 20, 0, null).ok, true);
  for (let i = 0; i < 6; i++) { now += STEP_MS; gw.frame(now); await new Promise((r) => setTimeout(r, 15)); }
  const before = sets;
  let maxErr = 0, errSum = 0, n = 0;
  const TICKS = 20, STEP_M = 0.5;
  for (let i = 0; i < TICKS; i++) {
    const x = 40 + i * STEP_M;
    assert.equal(applyTeleport(gw.world, mEntity, x, 0, null).ok, true);
    now += STEP_MS;
    gw.frame(now);
    await new Promise((r) => setTimeout(r, 15));
    const seen = mirror.entities.get(mEntity)?.transform?.px;
    if (seen !== undefined && i >= 2) { const e = Math.abs(seen - x); maxErr = Math.max(maxErr, e); errSum += e; n++; }
  }
  // One more tick with no movement lets a skipped session's catch-up land.
  now += STEP_MS; gw.frame(now); await new Promise((r) => setTimeout(r, 15));
  now += STEP_MS; gw.frame(now); await new Promise((r) => setTimeout(r, 15));
  const finalX = mirror.entities.get(mEntity)?.transform?.px ?? NaN;
  const received = sets - before - 2;
  watcher.close();
  mover.close();
  return { received, maxErr, meanErr: errSum / Math.max(1, n), finalErr: Math.abs(finalX - (40 + (TICKS - 1) * STEP_M)), skipped: gw.capStats.skipped, TICKS };
}

it("without the flag every tick is sent", async () => {
  const r = await run(undefined);
  assert.equal(r.skipped, 0);
  assert.ok(r.received >= r.TICKS - 1, `received ${r.received}`);
  assert.ok(r.maxErr < 1e-3);
});

it("with the cap a quiet session gets about half the DeltaSets, lags at most one tick of movement, and converges", async () => {
  const r = await run("1000000");
  assert.ok(r.skipped >= 5, `skipped ${r.skipped}`);
  assert.ok(r.received <= r.TICKS - 5 && r.received >= r.TICKS / 2 - 2, `received ${r.received} of ${r.TICKS}`);
  assert.ok(r.maxErr <= 0.5 + 1e-3, `max error ${r.maxErr}`);
  assert.ok(r.finalErr < 1e-3, `final error ${r.finalErr}`);
});
