/**
 * Phase 5, Part A: transport publish/subscribe. A publish reaches
 * exactly the topic's subscribers (and nobody else), unsubscribe stops
 * delivery, and publishing to an empty topic is a silent no-op. Both
 * transports behave the same (uWS natively, `ws` via the registry).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import {
  createTransport,
  loadUws,
  type Transport,
  type WireSocket,
} from "../../src/net/transport.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function start(kind: "uws" | "ws"): Promise<{ t: Transport; port: number; sockets: WireSocket[] }> {
  const t = createTransport(kind);
  const sockets: WireSocket[] = [];
  const port = await t.listen(0, { connection: (s) => sockets.push(s), http: null });
  return { t, port, sockets };
}

async function connect(port: number): Promise<{ ws: WebSocket; received: number[][] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: number[][] = [];
  ws.on("message", (d: Buffer) => received.push([...d]));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, received };
}

/** Wait until `cond()` holds (or time out): publish delivery is async. */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}

const kinds = loadUws() ? (["uws", "ws"] as const) : (["ws"] as const);

describe("transport publish/subscribe", () => {
  for (const kind of kinds) {
    describe(kind, () => {
      it("publishes to exactly the topic's subscribers", async () => {
        const { t, port, sockets } = await start(kind);
        try {
          const a = await connect(port);
          const b = await connect(port);
          const c = await connect(port);
          await waitFor(() => sockets.length === 3, "3 server sockets");
          const [sa, sb, sc] = sockets;
          sa.subscribe("sector:0,0");
          sb.subscribe("sector:0,0");
          sc.subscribe("sector:1,0");

          t.publish("sector:0,0", Uint8Array.of(1, 2, 3));
          await waitFor(() => a.received.length === 1 && b.received.length === 1, "A + B to get one publish");
          assert.deepEqual(a.received[0], [1, 2, 3]);
          assert.deepEqual(b.received[0], [1, 2, 3]);
          assert.deepEqual(c.received, []);

          t.publish("sector:1,0", Uint8Array.of(9));
          await waitFor(() => c.received.length === 1, "C to get its topic");
          assert.deepEqual(c.received[0], [9]);
          assert.equal(a.received.length, 1);
          assert.equal(b.received.length, 1);
        } finally {
          await t.close();
        }
      });

      it("unsubscribe stops delivery; double subscribe is one delivery", async () => {
        const { t, port, sockets } = await start(kind);
        try {
          const a = await connect(port);
          await waitFor(() => sockets.length === 1, "1 server socket");
          const [sa] = sockets;
          sa.subscribe("sector:0,0");
          sa.subscribe("sector:0,0"); // idempotent
          t.publish("sector:0,0", Uint8Array.of(1));
          await waitFor(() => a.received.length === 1, "first publish");
          assert.equal(a.received.length, 1);

          sa.unsubscribe("sector:0,0");
          t.publish("sector:0,0", Uint8Array.of(2));
          await sleep(100);
          assert.equal(a.received.length, 1, "nothing after unsubscribe");

          sa.unsubscribe("sector:never-joined"); // no-op, no throw
          t.publish("sector:empty", Uint8Array.of(3)); // no subscribers: no-op
          await sleep(50);
          assert.equal(a.received.length, 1);
        } finally {
          await t.close();
        }
      });

      it("a closed socket's subscriptions die with it", async () => {
        const { t, port, sockets } = await start(kind);
        try {
          const a = await connect(port);
          const b = await connect(port);
          await waitFor(() => sockets.length === 2, "2 server sockets");
          const [sa, sb] = sockets;
          sa.subscribe("sector:0,0");
          sb.subscribe("sector:0,0");
          a.ws.close();
          await waitFor(() => !sa.isOpen, "server socket to close");
          await sleep(50);
          t.publish("sector:0,0", Uint8Array.of(7));
          await waitFor(() => b.received.length === 1, "B to get the publish");
          assert.deepEqual(b.received[0], [7]);
          assert.equal(a.received.length, 0);
        } finally {
          await t.close();
        }
      });

      it("publish before listen and after close is a no-op", async () => {
        const t = createTransport(kind);
        t.publish("sector:0,0", Uint8Array.of(1)); // never listened: no throw
        const port = await t.listen(0, { connection: () => {}, http: null });
        t.publish("sector:0,0", Uint8Array.of(1)); // no subscribers: no-op
        assert.ok(port > 0);
        await t.close();
        t.publish("sector:0,0", Uint8Array.of(1)); // after close: no throw
      });
    });
  }
});
