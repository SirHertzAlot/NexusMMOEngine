/**
 * The port's two transports behave the same: binary messages both ways
 * (bytes the listener may keep), the peer's IP, close codes and reasons,
 * re-routing a socket's listeners, HTTP requests with headers and bodies
 * (and the body limit), 404 for the rest, and close() dropping every
 * connection. "auto" picks uWebSockets.js when it loads.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import {
  createTransport,
  HttpBodyTooLarge,
  loadUws,
  peerText,
  type HttpHandler,
  type Transport,
  type WireSocket,
} from "../../src/net/transport.js";

const once = <T>(fn: (resolve: (v: T) => void) => void): Promise<T> => new Promise(fn);

async function start(kind: "uws" | "ws", http: HttpHandler | null = null): Promise<{ t: Transport; port: number; sockets: WireSocket[] }> {
  const t = createTransport(kind);
  const sockets: WireSocket[] = [];
  const port = await t.listen(0, { connection: (s) => sockets.push(s), http });
  return { t, port, sockets };
}

async function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await once<void>((r) => ws.once("open", () => r()));
  return ws;
}

const kinds = loadUws() ? (["uws", "ws"] as const) : (["ws"] as const);

describe("peerText", () => {
  it("gives an IPv4 peer its dotted address, whichever form the transport wrote it in", () => {
    assert.equal(peerText("0000:0000:0000:0000:0000:ffff:7f00:0001"), "127.0.0.1");
    assert.equal(peerText("::ffff:203.0.113.7"), "203.0.113.7");
    assert.equal(peerText("127.0.0.1"), "127.0.0.1");
    assert.equal(peerText("2001:db8::1"), "2001:db8::1");
    assert.equal(peerText("unknown"), "unknown");
  });
});

describe("transport", () => {
  it("auto takes uWebSockets.js when it loads", () => {
    assert.equal(createTransport("auto").kind, loadUws() ? "uws" : "ws");
  });

  for (const kind of kinds) {
    describe(kind, () => {
      it("carries binary messages both ways, and knows the peer", async () => {
        const { t, port, sockets } = await start(kind);
        const client = await connect(port);
        const received: Uint8Array[] = [];
        const got = once<void>((r) =>
          sockets.length ? r() : setTimeout(() => r(), 50),
        );
        await got;
        assert.equal(sockets.length, 1);
        const s = sockets[0];
        assert.match(s.remoteIp, /127\.0\.0\.1/);
        assert.ok(s.isOpen);
        const twoMessages = once<void>((r) =>
          s.listen({
            message: (d) => {
              received.push(d);
              if (received.length === 2) r();
            },
            close: () => {},
          }),
        );
        client.send(Uint8Array.of(1, 2, 3));
        client.send(Uint8Array.of(9, 8));
        await twoMessages;
        // Kept past the callback: the bytes are the listener's.
        assert.deepEqual([...received[0]], [1, 2, 3]);
        assert.deepEqual([...received[1]], [9, 8]);

        const echoed = once<Buffer>((r) => client.once("message", (d: Buffer) => r(d)));
        s.send(Uint8Array.of(7, 7, 7, 7));
        assert.deepEqual([...(await echoed)], [7, 7, 7, 7]);
        client.close();
        await t.close();
      });

      it("closes with a code and reason, fires close once, and ignores sends after", async () => {
        const { t, port, sockets } = await start(kind);
        const client = await connect(port);
        while (!sockets.length) await new Promise((r) => setTimeout(r, 5));
        const s = sockets[0];
        let closes = 0;
        const closed = once<void>((r) => s.listen({ message() {}, close: () => (closes++, r()) }));
        const clientSaw = once<[number, string]>((r) => client.once("close", (code: number, reason: Buffer) => r([code, reason.toString()])));
        s.close(4000, "superseded by new connection");
        assert.deepEqual(await clientSaw, [4000, "superseded by new connection"]);
        await closed;
        assert.equal(s.isOpen, false);
        s.send(Uint8Array.of(1)); // no throw, no crash
        s.close(1000, "again");
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(closes, 1);
        await t.close();
      });

      it("routes to the current listener only", async () => {
        const { t, port, sockets } = await start(kind);
        const client = await connect(port);
        while (!sockets.length) await new Promise((r) => setTimeout(r, 5));
        const first: number[] = [];
        sockets[0].listen({ message: (d) => first.push(d[0]), close() {} });
        const second = once<number>((r) => sockets[0].listen({ message: (d) => r(d[0]), close() {} }));
        client.send(Uint8Array.of(42));
        assert.equal(await second, 42);
        assert.deepEqual(first, []);
        client.close();
        await t.close();
      });

      it("serves HTTP on the same port: headers, bodies, the limit, 404", async () => {
        const http: HttpHandler = (req, res) => {
          if (!req.url.startsWith("/echo")) return false;
          req.readBody(16).then(
            (body) => res.send(200, { "Content-Type": "application/json", "X-Test": "yes" }, JSON.stringify({
              method: req.method, url: req.url, auth: req.header("Authorization"), body: new TextDecoder().decode(body),
            })),
            (err: unknown) => res.send(err instanceof HttpBodyTooLarge ? 413 : 500, {}, String(err)),
          );
          return true;
        };
        const { t, port } = await start(kind, http);
        const base = `http://127.0.0.1:${port}`;
        const ok = await fetch(`${base}/echo?x=1`, { method: "POST", headers: { Authorization: "Bearer abc" }, body: "hello" });
        assert.equal(ok.status, 200);
        assert.equal(ok.headers.get("x-test"), "yes");
        assert.deepEqual(await ok.json(), { method: "POST", url: "/echo?x=1", auth: "Bearer abc", body: "hello" });
        const empty = await fetch(`${base}/echo`, { method: "POST" });
        assert.equal((await empty.json()).body, "");
        const big = await fetch(`${base}/echo`, { method: "POST", body: "x".repeat(1000) });
        assert.equal(big.status, 413);
        const missing = await fetch(`${base}/nope`);
        assert.equal(missing.status, 404);
        await t.close();
      });

      it("close() drops every connection and stops listening", async () => {
        const { t, port } = await start(kind);
        const clients = await Promise.all([connect(port), connect(port), connect(port)]);
        const allClosed = Promise.all(clients.map((c) => once<void>((r) => c.once("close", () => r()))));
        await t.close();
        await allClosed;
        const late = new WebSocket(`ws://127.0.0.1:${port}`);
        const refused = await once<boolean>((r) => {
          late.once("open", () => r(false));
          late.once("error", () => r(true));
        });
        assert.ok(refused, "nothing answers on the port");
      });
    });
  }
});
