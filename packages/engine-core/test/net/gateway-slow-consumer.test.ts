/**
 * Slow-consumer policy: a session whose socket backlog is over the soft limit gets no deltas, a replace baseline once
 * the backlog drains, and is closed when it stays slow past the hold timeout. The backlog is stubbed on the server-side
 * socket (bufferedAmount) so the test needs no real stalled reader.
 */
import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { decodeDeltaSet, MessageType } from "@mmo-engine/protocol";
import { Gateway } from "../../src/net/gateway.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

const STEP_MS = 1000 / 30;
let now = 0;
let gw: Gateway | null = null;

afterEach(async () => {
  await gw?.close();
  gw = null;
});

function frames(n: number): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    gw!.frame(now);
  }
}

type Sess = { welcomed: boolean; slowHold?: boolean; needsResync: boolean; socket: { bufferedAmount?: () => number } | null; playerEntity: bigint | null };
const sessionOf = (entity: bigint): Sess => [...(gw as unknown as { sessions: Map<string, Sess> }).sessions.values()].find((s) => s.playerEntity === entity)!;
const tick = async (n: number, c: HeadlessClient): Promise<Uint8Array[]> => {
  const w = c.waitFor(MessageType.DeltaSet, n);
  frames(n);
  return w;
};

it("holds a session over the soft limit, sends a replace baseline when it drains, and closes one that stays slow", async () => {
  now = 1_000_000;
  gw = new Gateway({ clock: () => now, credentialStore: await makeCredentialStore(), interest: { enterM: 96, leaveM: 128 } });
  const url = `ws://127.0.0.1:${await gw.listen()}`;
  gw.frame(now);
  const slow = new HeadlessClient();
  await slow.connect(url);
  const welcome = await slow.hello("alice", { username: "alice", password: TEST_PASSWORD });
  const other = new HeadlessClient();
  await other.connect(url);
  await other.hello("user-a", { username: "user-a", password: TEST_PASSWORD });
  await tick(3, slow);

  const s = sessionOf(BigInt(welcome.player_entity));
  let backlog = 0;
  s.socket!.bufferedAmount = () => backlog;

  // Under the limit: deltas flow, no hold.
  backlog = 100 * 1024;
  const flowing = await tick(2, slow);
  assert.equal(flowing.length, 2);
  assert.ok(!s.slowHold);

  // Over the soft limit: the session is held and gets no DeltaSet; the other client still does.
  backlog = 3 * 1024 * 1024;
  let got = 0;
  const rawWs = (slow as unknown as { ws: { on(ev: string, fn: (...a: never[]) => void): void } }).ws;
  rawWs.on("message", ((m: Uint8Array) => { if (m[0] === MessageType.DeltaSet) got++; }) as (...a: never[]) => void);
  frames(5);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.slowHold, true, "held");
  assert.equal(s.needsResync, true, "marked for a replace baseline");
  assert.equal(got, 0, "no DeltaSet while held");
  assert.ok(gw.slowStats.holds >= 1 && gw.slowStats.skipped >= 5);

  // Drained to the low mark: the next DeltaSet is a replace baseline.
  backlog = 64 * 1024;
  const after = await tick(2, slow);
  assert.equal(s.slowHold, false, "released");
  assert.equal(decodeDeltaSet(after[0]).replace, true, "the first set after the hold is a replace baseline");
  assert.ok(gw.slowStats.releases >= 1);

  // Stays slow past the hold timeout: closed with the slow-consumer reason.
  backlog = 5 * 1024 * 1024;
  frames(1);
  assert.equal(s.slowHold, true);
  now += 20_000;
  frames(1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(slow.closed, true, "the slow client was closed");
  assert.equal(slow.closeCode, 4000);
  assert.equal(gw.slowStats.closes, 1);
  other.close();
});
