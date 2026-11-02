/** E3b: the game port relays players' WebSocket and HTTP to the core, over a real channel. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { ChannelClient, serveChannel, type ChannelPacket, type ChannelServer } from "@mmo-engine/channel";
import { startGameRelay } from "../src/game-relay.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await sleep(10); }
}
const b64 = (s: string) => Buffer.from(s).toString("base64");

/** A stand-in core: greets each socket, echoes its frames, subscribes it to a topic, answers HTTP. */
async function fakeCore() {
  const seen: string[] = [];
  const core: { server: ChannelServer | null } = { server: null };
  const push = (type: string, payload: unknown) => core.server!.pushToAll(type, payload);
  core.server = await serveChannel(0, async (p: ChannelPacket) => {
    const o = p.payload as Record<string, string>;
    seen.push(p.type);
    if (p.type === "wire.open") {
      push("wire.send", { sid: o.sid, data: Buffer.from("welcome") });
      push("wire.sub", { sid: o.sid, topic: "sector:1" });
    } else if (p.type === "wire.msg") {
      const text = Buffer.from(o.data as unknown as Uint8Array).toString();
      if (text === "bye") push("wire.end", { sid: o.sid, code: 4000, reason: "done" });
      else push("wire.send", { sid: o.sid, data: Buffer.from("echo:" + text) });
    } else if (p.type === "http") {
      return { status: 200, headers: { "content-type": "text/plain" }, body: b64(`${o.method} ${o.url} ${Buffer.from(o.body, "base64").toString()}`) };
    }
    return null;
  });
  return { core, seen, push };
}

test("a player's socket and HTTP go through the edge to the core and back", async () => {
  const { core, seen, push } = await fakeCore();
  const channel = new ChannelClient({ port: core.server!.port, heartbeatMs: 50, maxMissed: 3 });
  await channel.connect();
  const relay = await startGameRelay(channel, 0, "127.0.0.1");
  try {
    const got: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`);
    ws.on("message", (d) => got.push(d.toString()));
    await new Promise((r) => ws.once("open", r));
    await until(() => got.includes("welcome"));
    ws.send("hi");
    await until(() => got.includes("echo:hi"));
    // A topic publish reaches subscribed sockets only.
    push("wire.publish", { topic: "sector:1", data: Buffer.from("delta") });
    push("wire.publish", { topic: "sector:2", data: Buffer.from("elsewhere") });
    await until(() => got.includes("delta"));
    await sleep(50);
    assert.ok(!got.includes("elsewhere"));

    const res = await fetch(`http://127.0.0.1:${relay.port}/rpc/Pcg/ListAssets`, { method: "POST", body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "POST /rpc/Pcg/ListAssets {}");

    // The core closes the socket; the edge closes the player's, and tells the core it's gone.
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    ws.send("bye");
    assert.equal(await closed, 4000);
    await until(() => seen.includes("wire.close"));
    assert.equal(relay.size, 0);
  } finally {
    await relay.close();
    channel.close();
    await core.server!.close();
  }
});

test("with the core down, new sockets are refused and HTTP answers 503", async () => {
  const { core } = await fakeCore();
  const channel = new ChannelClient({ port: core.server!.port, heartbeatMs: 50, maxMissed: 3 });
  await channel.connect();
  const relay = await startGameRelay(channel, 0, "127.0.0.1");
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`);
    await new Promise((r) => ws.once("open", r));
    const dropped = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    await core.server!.close();
    assert.equal(await dropped, 1012, "open sockets close so the client reconnects");
    await until(() => channel.status === "down");
    const refused = new WebSocket(`ws://127.0.0.1:${relay.port}`);
    assert.equal(await new Promise<number>((r) => refused.once("close", (code) => r(code))), 1013);
    assert.equal((await fetch(`http://127.0.0.1:${relay.port}/health`)).status, 503);
  } finally {
    await relay.close();
    channel.close();
  }
});
