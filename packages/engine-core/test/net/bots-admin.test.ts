/**
 * Admin `bots` command (roadmap A7) against a real Gateway: `bots <count>`
 * starts bot workers that log in over WebSocket as accounts in the
 * credential store and join the world; `bots stop` disconnects them.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  encodeControl,
  MessageType,
  type AdminResult,
} from "@mmo-engine/protocol";
import { Gateway } from "../../src/net/gateway.js";
import { hashPassword } from "../../src/index.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

let gw: Gateway | null = null;
let now = 0;

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

async function waitFor(check: () => boolean, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Sessions the gateway holds (live sockets and players in their grace period). */
function sessionCount(g: Gateway): number {
  return (g as unknown as { sessions: Map<string, unknown> }).sessions.size;
}

describe("admin bots command against a real gateway", () => {
  it("`bots <count>` logs bots into the gateway and `bots stop` removes them", async () => {
    // Worker keys start at 0 in this test process, so the bots are bot-bots-0-0 and bot-bots-1-0.
    const store = await makeCredentialStore();
    const hash = await hashPassword(TEST_PASSWORD);
    await store.createUser("bot-bots-0-0", hash);
    await store.createUser("bot-bots-1-0", hash);

    const saved = { url: process.env.BOT_WS_URL, pw: process.env.BOT_PASSWORD };
    now = 1_000_000;
    gw = new Gateway({
      clock: () => now,
      disconnectGraceMs: 1000,
      credentialStore: store,
      admins: ["alice"],
    });
    const port = await gw.listen();
    gw.frame(now);
    process.env.BOT_WS_URL = `ws://127.0.0.1:${port}`;
    process.env.BOT_PASSWORD = TEST_PASSWORD;

    try {
      const alice = new HeadlessClient();
      await alice.connect(`ws://127.0.0.1:${port}`);
      await alice.hello("alice", { username: "alice", password: TEST_PASSWORD });

      const run = async (args: unknown): Promise<AdminResult> => {
        const resP = alice.waitFor(MessageType.Admin, 1);
        alice.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "bots", args }));
        const [payload] = await resP;
        return decodeControl<AdminResult>(payload);
      };

      const spawned = await run({ count: "2" });
      assert.equal(spawned.ok, true, spawned.message);
      await waitFor(() => sessionCount(gw!) === 3);

      const stopped = await run({ stop: "stop" });
      assert.equal(stopped.ok, true);
      assert.equal(stopped.message, "stopped 2 bot worker(s)");

      // The bots' sockets close; the grace period (test clock) then ends their sessions.
      await waitFor(() => {
        now += 5000;
        gw!.frame(now);
        return sessionCount(gw!) === 1;
      });
      await alice.close();
    } finally {
      if (saved.url === undefined) delete process.env.BOT_WS_URL;
      else process.env.BOT_WS_URL = saved.url;
      if (saved.pw === undefined) delete process.env.BOT_PASSWORD;
      else process.env.BOT_PASSWORD = saved.pw;
    }
  });
});
