import { test } from "node:test";
import assert from "node:assert/strict";
import { netLogger, Registry } from "@mmo-engine/nethealth";
import { ChannelClient } from "../src/client.js";
import { serveChannel } from "../src/server.js";
import { channelMetrics } from "../src/metrics.js";
import { encodeFrame, FrameTooLargeError, MAX_FRAME_BYTES } from "../src/framing.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met within " + ms + "ms");
    await sleep(10);
  }
}

test("both sides count requests, errors, timeouts, pushes and bytes", async () => {
  const coreReg = new Registry("mmo_");
  const edgeReg = new Registry("mmo_");
  const core = channelMetrics(coreReg);
  const edge = channelMetrics(edgeReg);
  const server = await serveChannel(0, async (p) => {
    if (p.type === "boom") throw new Error("no");
    if (p.type === "slow") await sleep(200);
    return { ok: true };
  }, "127.0.0.1", { metrics: core });
  const client = new ChannelClient({ port: server.port, metrics: edge });
  await client.connect();

  await client.request("a", {}, "1");
  await client.request("a", {}, "2");
  await assert.rejects(client.request("boom", {}, "3"), /no/);
  await assert.rejects(client.request("slow", {}, "4", 20), /timeout/);
  let got = 0;
  client.onPush("tick.events", () => got++);
  server.pushToAll("tick.events", { n: 1 });
  await until(() => got === 1, 1000);
  await sleep(250); // let the slow handler finish on the core

  const E = { side: "edge" }, C = { side: "core" };
  assert.equal(edge.requests.get(E), 4);
  assert.equal(edge.errors.get(E), 1);
  assert.equal(edge.timeouts.get(E), 1);
  assert.equal(edge.latency.series.values().next().value!.count, 2);
  assert.equal(edge.pushes.get({ side: "edge", type: "tick.events" }), 1);
  assert.equal(core.requests.get(C), 4);
  assert.equal(core.errors.get(C), 1);
  assert.equal(core.pushes.get({ side: "core", type: "tick.events" }), 1);
  // Every byte one side wrote, the other read.
  await until(() => edge.bytesSent.get(E) === core.bytesReceived.get(C), 1000);
  assert.equal(core.bytesSent.get(C), edge.bytesReceived.get(E));
  assert.ok(edge.bytesSent.get(E) > 0);
  assert.match(edgeReg.scrape(), /mmo_channel_request_latency_ms_bucket\{side="edge",le="\+Inf"\} 2/);
  client.close();
  await server.close();
});

test("lifecycle: up, down, reconnect and missed heartbeats are counted and logged", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const log = netLogger("channel", (l) => lines.push(JSON.parse(l)));
  const m = channelMetrics(new Registry("mmo_"));
  let server = await serveChannel(0, async () => ({}));
  const port = server.port;
  const client = new ChannelClient({ port, metrics: m, log, heartbeatMs: 30, maxMissed: 100 });
  await client.connect();
  await server.close();
  await until(() => client.status === "down", 1000);
  server = await serveChannel(port, async () => ({}));
  await until(() => client.status === "up", 3000);
  assert.equal(m.reconnects.get({ side: "edge" }), 1);
  assert.deepEqual(lines.map((l) => l.event).filter((e) => e !== "heartbeat.missed"), ["channel.up", "channel.down", "channel.reconnect", "channel.up"]);
  assert.equal(lines.find((l) => l.event === "channel.reconnect")!.attempt, 1);
  client.close();
  await server.close();

  // A core that never answers: heartbeats go missing.
  const { createServer } = await import("node:net");
  const silent = createServer(() => {});
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  const p2 = (silent.address() as { port: number }).port;
  const c2 = new ChannelClient({ port: p2, metrics: m, log, heartbeatMs: 20, maxMissed: 3 });
  await c2.connect();
  await until(() => m.heartbeatMissed.get({ side: "edge" }) >= 3, 2000);
  assert.ok(lines.some((l) => l.event === "heartbeat.missed" && l.level === "warn"));
  c2.close();
  silent.close();
});

test("an oversized frame logs frame.oversized with its size and nothing else", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const log = netLogger("channel", (l) => lines.push(JSON.parse(l)));
  const server = await serveChannel(0, async () => ({}));
  const client = new ChannelClient({ port: server.port, log });
  await client.connect();
  const big = "x".repeat(MAX_FRAME_BYTES);
  await assert.rejects(client.request("big", big, "1"), (e: unknown) => e instanceof FrameTooLargeError);
  const line = lines.find((l) => l.event === "frame.oversized")!;
  assert.equal(line.level, "error");
  assert.ok((line.bytes as number) > MAX_FRAME_BYTES);
  assert.ok(!JSON.stringify(line).includes("xxxx"));
  assert.throws(() => encodeFrame(big), FrameTooLargeError);
  client.close();
  await server.close();
});
