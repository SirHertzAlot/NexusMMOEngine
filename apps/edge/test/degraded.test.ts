/** E4: degraded mode and resync, with a real channel client and server. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChannelClient, serveChannel, type ChannelPacket, type ChannelServer } from "@mmo-engine/channel";
import { createCoreLifecycle } from "../src/lifecycle.js";
import { pingHandler } from "../src/modules/ping.js";
import { loadRoutes, routePacket, type RouterCtx } from "../src/router.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const routes = loadRoutes(join(ROOT, "content", "edge", "routes.json"));
const MESSAGE = "The world is restarting. Your connection is safe — try again shortly.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await sleep(10); }
}

/** A fake core: logins mint tokens, core.sync lists the ones it still has. */
function fakeCore(live: Set<string>) {
  let n = 0;
  return async (p: ChannelPacket): Promise<unknown> => {
    switch (p.type) {
      case "auth.login": { const token = "tok-" + (n++); live.add(token); return { ok: true, token, playerId: "alice" }; }
      case "player.intent": return { accepted: true, tick: 7 };
      case "core.sync": return { tick: 42, sessionIds: [...live] };
      default: throw new Error("unknown packet type " + p.type);
    }
  };
}

function edge(port: number) {
  const channel = new ChannelClient({ port, heartbeatMs: 50, maxMissed: 3 });
  const logs: string[] = [];
  const requests: string[] = [];
  const request = channel.request.bind(channel);
  channel.request = (type, payload, id, timeoutMs) => { requests.push(type); return request(type, payload, id, timeoutMs); };
  const lifecycle = createCoreLifecycle(channel, { log: (l) => logs.push(l), syncTimeoutMs: 200 });
  const ctx: RouterCtx = { channel, modules: { ping: pingHandler } };
  const send = async (type: string, payload: unknown = {}) => {
    const r = await routePacket({ type, id: "c1", payload }, routes, ctx);
    lifecycle.observe(r);
    return r;
  };
  return { channel, lifecycle, logs, requests, send };
}

test("core down: core-bound packets answer core.unavailable, local routes keep working, health says down", async () => {
  const live = new Set<string>();
  const server = await serveChannel(0, fakeCore(live));
  const e = edge(server.port);
  await e.channel.connect();
  assert.equal(e.lifecycle.health().core, "up");
  assert.deepEqual((await e.send("player.intent")).payload, { accepted: true, tick: 7 });

  await server.close();
  await until(() => e.lifecycle.coreStatus === "down");
  const r = await e.send("player.intent", { mx: 1 });
  assert.deepEqual(r, { type: "core.unavailable", id: "c1", payload: { retry: true, message: MESSAGE } });
  assert.deepEqual((await e.send("ping")).payload, { pong: true });
  assert.deepEqual(e.lifecycle.health(), { ok: true, core: "down" });
  assert.match(e.logs[0], /^core channel down at \d{4}-\d\d-\d\dT[\d:.]+Z$/);
  e.channel.close();
});

test("core back: resync runs first, prunes unknown sessions, then intents flow", async () => {
  const live = new Set<string>();
  let server: ChannelServer = await serveChannel(0, fakeCore(live));
  const port = server.port;
  const e = edge(port);
  await e.channel.connect();
  const a = (await e.send("auth.login", { username: "alice", password: "x" })).payload as { token: string };
  const b = (await e.send("auth.login", { username: "bob", password: "x" })).payload as { token: string };
  assert.deepEqual([...e.lifecycle.knownSessions], [a.token, b.token]);

  await server.close();
  await until(() => e.lifecycle.coreStatus === "down");
  live.delete(b.token); // the restarted core lost bob's session
  e.requests.length = 0;
  server = await serveChannel(port, fakeCore(live));
  await until(() => e.lifecycle.coreStatus === "up"); // backoff starts at 1000 ms
  await e.lifecycle.settled();
  assert.equal(e.requests[0], "core.sync");
  assert.deepEqual([...e.lifecycle.knownSessions], [a.token]);
  assert.match(e.logs.at(-1)!, /^core resync complete at \S+Z tick=42 sessions=1$/);
  assert.deepEqual((await e.send("player.intent")).payload, { accepted: true, tick: 7 });
  assert.deepEqual(e.lifecycle.health(), { ok: true, core: "up" });
  e.channel.close();
  await server.close();
});

test("a sync that never answers leaves the core down and sessions untouched", async () => {
  const live = new Set<string>();
  const server = await serveChannel(0, fakeCore(live));
  const port = server.port;
  const e = edge(port);
  await e.channel.connect();
  const a = (await e.send("auth.login", {})).payload as { token: string };
  await server.close();
  await until(() => e.lifecycle.coreStatus === "down");

  // A core that accepts TCP but never says anything.
  const silent = createServer(() => {});
  await new Promise<void>((r) => silent.listen(port, "127.0.0.1", () => r()));
  assert.equal((silent.address() as AddressInfo).port, port);
  await until(() => e.channel.status === "up");
  await e.lifecycle.settled();
  assert.equal(e.lifecycle.coreStatus, "down");
  assert.deepEqual([...e.lifecycle.knownSessions], [a.token]);
  assert.ok(e.logs.some((l) => l.startsWith("core resync failed at ")));
  assert.ok(!e.logs.some((l) => l.startsWith("core resync complete")));
  e.channel.close();
  silent.close();
});
