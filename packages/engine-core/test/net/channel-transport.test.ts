/**
 * E3b: the gateway's port through the edge. ChannelTransport turns the edge's wire.* / http packets into
 * WireSockets and HTTP requests, and the gateway's sends into pushes back to the edge.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ChannelTransport } from "../../src/net/channel-transport.js";
import type { HttpHandler, WireSocket } from "../../src/net/transport.js";

function setup(http: HttpHandler | null = null) {
  const pushes: { type: string; payload: Record<string, unknown> }[] = [];
  const t = new ChannelTransport((type, payload) => pushes.push({ type, payload: payload as Record<string, unknown> }), 4000);
  const sockets: WireSocket[] = [];
  const got: { msg: string[]; closed: number } = { msg: [], closed: 0 };
  const listening = t.listen(0, {
    connection: (s) => {
      sockets.push(s);
      s.listen({ message: (d) => got.msg.push(Buffer.from(d).toString()), close: () => got.closed++ });
    },
    http,
  });
  const packet = (type: string, payload: unknown) => t.handle({ type, id: "push-1", payload });
  return { t, pushes, sockets, got, listening, packet };
}
const b64 = (s: string) => Buffer.from(s).toString("base64");

test("a relayed socket: open, frames both ways, topics, and the close round trip", async () => {
  const { t, pushes, sockets, got, listening, packet } = setup();
  assert.equal(await listening, 4000, "listens on the channel's port");
  await packet("wire.open", { sid: "e1-0", ip: "10.0.0.5" });
  assert.equal(sockets.length, 1);
  const s = sockets[0];
  assert.equal(s.remoteIp, "10.0.0.5");
  assert.ok(s.isOpen);

  await packet("wire.msg", { sid: "e1-0", data: Buffer.from("hello") });
  assert.deepEqual(got.msg, ["hello"]);

  s.send(new TextEncoder().encode("welcome"));
  s.subscribe("sector:1");
  t.publish("sector:1", new TextEncoder().encode("delta"));
  assert.deepEqual(pushes.map((p) => p.type), ["wire.send", "wire.sub", "wire.publish"]);
  assert.equal(Buffer.from(pushes[0].payload.data as Uint8Array).toString(), "welcome");
  assert.deepEqual(pushes[1].payload, { sid: "e1-0", topic: "sector:1" });

  // The gateway closes: the edge is told, sends stop, and close fires when the edge confirms.
  s.close(4001, "bye");
  assert.deepEqual(pushes.at(-1), { type: "wire.end", payload: { sid: "e1-0", code: 4001, reason: "bye" } });
  assert.equal(s.isOpen, false);
  s.send(new Uint8Array([1]));
  assert.equal(pushes.at(-1)?.type, "wire.end", "no sends after close");
  assert.equal(got.closed, 0);
  await packet("wire.close", { sid: "e1-0" });
  await packet("wire.close", { sid: "e1-0" });
  assert.equal(got.closed, 1, "close fires once");
  assert.equal(t.size, 0);
});

test("the edge going away closes its sockets; before listen() an open is refused", async () => {
  const early = new ChannelTransport(() => {}, 4000);
  const refused: unknown[] = [];
  const t0 = new ChannelTransport((type, payload) => refused.push({ type, payload }), 4000);
  await t0.handle({ type: "wire.open", id: "push-1", payload: { sid: "x", ip: "1.2.3.4" } });
  assert.deepEqual(refused, [{ type: "wire.end", payload: { sid: "x", code: 1013, reason: "server not ready" } }]);
  assert.equal(early.handle({ type: "player.intent", id: "1", payload: {} }), undefined, "other packets are not the relay's");

  const { t, got, listening, packet } = setup();
  await listening;
  await packet("wire.open", { sid: "a", ip: "1.1.1.1" });
  await packet("wire.open", { sid: "b", ip: "1.1.1.1" });
  t.edgeGone();
  assert.equal(got.closed, 2);
  assert.equal(t.size, 0);
  await packet("wire.msg", { sid: "a", data: Buffer.from("late") });
  assert.deepEqual(got.msg, [], "frames for a gone socket are dropped");
});

test("HTTP is relayed as a request: the gateway's handler answers it, or 404", async () => {
  const handler: HttpHandler = (req, res) => {
    if (!req.url.startsWith("/rpc/Pcg/")) return false;
    void req.readBody(1024).then((body) => res.send(200, { "Content-Type": "application/json" }, JSON.stringify({ url: req.url, auth: req.header("Authorization"), body: Buffer.from(body).toString() })));
    return true;
  };
  const { listening, packet } = setup(handler);
  await listening;
  const ok = (await packet("http", { method: "POST", url: "/rpc/Pcg/ListAssets", headers: { authorization: "Bearer t" }, body: b64("{}") })) as { status: number; body: string };
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(Buffer.from(ok.body, "base64").toString()), { url: "/rpc/Pcg/ListAssets", auth: "Bearer t", body: "{}" });
  const missing = (await packet("http", { method: "GET", url: "/nope", headers: {}, body: "" })) as { status: number };
  assert.equal(missing.status, 404);
});
