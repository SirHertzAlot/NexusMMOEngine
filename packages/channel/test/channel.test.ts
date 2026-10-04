import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { ChannelClient } from "../src/client.js";
import { serveChannel } from "../src/server.js";
import type { ChannelPacket } from "../src/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met within " + ms + "ms");
    await sleep(10);
  }
}

const echo = async (p: ChannelPacket) => ({ echoed: p.payload });

test("request/response round trip", async () => {
  const server = await serveChannel(0, echo);
  const client = new ChannelClient({ port: server.port });
  await client.connect();
  assert.equal(client.status, "up");
  assert.deepEqual(await client.request("test.type", { x: 1 }, "1"), { echoed: { x: 1 } });
  // Two callers may reuse the same id; each still gets its own answer.
  const [a, b] = await Promise.all([client.request("t", "a", "7"), client.request("t", "b", "7")]);
  assert.deepEqual([a, b], [{ echoed: "a" }, { echoed: "b" }]);
  client.close();
  await server.close();
});

test("a handler throw rejects with the handler's message", async () => {
  const server = await serveChannel(0, async () => { throw new Error("no such thing"); });
  const client = new ChannelClient({ port: server.port });
  await client.connect();
  await assert.rejects(client.request("test.type", {}, "1"), { message: "no such thing" });
  client.close();
  await server.close();
});

test("a request with no answer times out with the exact message", async () => {
  const server = await serveChannel(0, () => new Promise(() => {}));
  const client = new ChannelClient({ port: server.port });
  await client.connect();
  await assert.rejects(client.request("test.type", {}, "1", 50), { message: "channel timeout after 50ms for test.type" });
  client.close();
  await server.close();
});

test("request while down rejects immediately", async () => {
  const client = new ChannelClient({ port: 1 });
  await assert.rejects(client.request("t", {}, "1"), { message: "channel down" });
});

test("server pushes reach the client's onPush handler", async () => {
  const server = await serveChannel(0, echo);
  const client = new ChannelClient({ port: server.port });
  const got: unknown[] = [];
  client.onPush("tick.events", (p) => got.push(p));
  await client.connect();
  await sleep(20); // let the server register the socket
  server.pushToAll("tick.events", { tick: 3, events: [] });
  await until(() => got.length === 1, 1000);
  assert.deepEqual(got, [{ tick: 3, events: [] }]);
  client.close();
  await server.close();
});

test("notify reaches the server handler without an answer", async () => {
  const seen: ChannelPacket[] = [];
  const server = await serveChannel(0, async (p) => { seen.push(p); return null; });
  const client = new ChannelClient({ port: server.port });
  await client.connect();
  client.notify("edge.note", { n: 1 });
  await until(() => seen.length === 1, 1000);
  assert.equal(seen[0].type, "edge.note");
  assert.match(seen[0].id, /^push-\d+$/);
  client.close();
  await server.close();
});

test("reconnects after the server restarts on the same port", async () => {
  let server = await serveChannel(0, echo);
  const port = server.port;
  const client = new ChannelClient({ port, heartbeatMs: 50 });
  const seen: string[] = [];
  client.onStatus((s) => seen.push(s));
  await client.connect();
  await server.close();
  await until(() => client.status === "down", 1000);
  server = await serveChannel(port, echo);
  await until(() => client.status === "up", 3000); // first backoff step is 1000 ms
  assert.deepEqual(seen, ["up", "down", "up"]);
  assert.deepEqual(await client.request("t", 1, "1"), { echoed: 1 });
  client.close();
  await server.close();
});

test("a silent peer is declared down after maxMissed heartbeats", async () => {
  const raw = createServer(() => {}); // accepts, never writes
  await new Promise<void>((r) => raw.listen(0, "127.0.0.1", () => r()));
  const port = (raw.address() as AddressInfo).port;
  const client = new ChannelClient({ port, heartbeatMs: 50, maxMissed: 3 });
  await client.connect();
  const t0 = Date.now();
  await until(() => client.status === "down", 1000);
  assert.ok(Date.now() - t0 < 400, "down within ~300 ms");
  client.close();
  raw.close();
});

test("heartbeats keep a quiet but live connection up", async () => {
  const server = await serveChannel(0, echo);
  const client = new ChannelClient({ port: server.port, heartbeatMs: 30, maxMissed: 2 });
  await client.connect();
  await sleep(300);
  assert.equal(client.status, "up");
  client.close();
  await server.close();
});

test("a malformed frame closes that socket and the server keeps serving", async () => {
  const server = await serveChannel(0, echo);
  const { connect } = await import("node:net");
  const bad = connect({ port: server.port, host: "127.0.0.1" });
  await new Promise<void>((r) => bad.on("connect", () => r()));
  const header = Buffer.alloc(4); header.writeUInt32BE(3, 0);
  bad.write(Buffer.concat([header, Buffer.from("{{{")]));
  await new Promise<void>((r) => bad.on("close", () => r()));
  const client = new ChannelClient({ port: server.port });
  await client.connect();
  assert.deepEqual(await client.request("t", 2, "1"), { echoed: 2 });
  client.close();
  await server.close();
});
