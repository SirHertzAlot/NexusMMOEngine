/**
 * MMO_UWS_CORK send batching, against a fake uWS module (no native binary, no network): held sends
 * are copied, written per socket in order inside one cork at endBatch, publish() flushes first, and
 * with the flag off nothing is held. The real-uWS syscall effect is measured separately.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UwsTransport, type WireSocket } from "../../src/net/transport.js";

interface FakeWs {
  getUserData(): { ip: string; socket: WireSocket | null };
  send(m: Uint8Array): number;
  cork(cb: () => void): void;
  end(): void;
  close(): void;
  subscribe(): boolean;
  unsubscribe(): boolean;
}

async function rig(cork: boolean): Promise<{ t: UwsTransport; log: string[]; open(ip: string): WireSocket }> {
  const prev = process.env.MMO_UWS_CORK;
  if (cork) process.env.MMO_UWS_CORK = "1";
  else delete process.env.MMO_UWS_CORK;
  const log: string[] = [];
  let behavior: { open(ws: FakeWs): void } | null = null;
  const app = {
    ws(_p: string, b: { open(ws: FakeWs): void }) {
      behavior = b;
      return app;
    },
    any: () => app,
    listen: (_port: number, cb: (t: unknown) => void) => {
      cb({});
      return app;
    },
    publish: (topic: string, m: Uint8Array) => {
      log.push(`pub:${topic}:${[...m].join(",")}`);
      return true;
    },
    close: () => app,
  };
  const t = new UwsTransport({ App: () => app, us_listen_socket_close() {}, us_socket_local_port: () => 1 } as never);
  if (prev === undefined) delete process.env.MMO_UWS_CORK;
  else process.env.MMO_UWS_CORK = prev;
  let sockets: WireSocket | null = null;
  await t.listen(0, { connection: (s) => (sockets = s), http: null });
  return {
    t,
    log,
    open(ip) {
      const data = { ip, socket: null as WireSocket | null };
      const ws: FakeWs = {
        getUserData: () => data,
        send: (m) => (log.push(`${ip}:${[...m].join(",")}`), 0),
        cork: (cb) => {
          log.push(`${ip}:cork`);
          cb();
          log.push(`${ip}:uncork`);
        },
        end() {},
        close() {},
        subscribe: () => true,
        unsubscribe: () => true,
      };
      behavior!.open(ws);
      void sockets;
      return data.socket!;
    },
  };
}

describe("UwsTransport send batching (MMO_UWS_CORK)", () => {
  it("is off by default: sends go straight out", async () => {
    const { t, log, open } = await rig(false);
    const a = open("a");
    t.beginBatch?.();
    a.send(Uint8Array.of(1));
    assert.deepEqual(log, ["a:1"]);
    t.endBatch?.();
  });

  it("holds sends until endBatch, one cork per socket, order kept", async () => {
    const { t, log, open } = await rig(true);
    const a = open("a");
    const b = open("b");
    t.beginBatch!();
    const buf = Uint8Array.of(1, 1);
    a.send(buf);
    buf[0] = 9; // a producer reusing its buffer must not corrupt the held copy
    a.send(Uint8Array.of(2));
    b.send(Uint8Array.of(3));
    assert.deepEqual(log, []);
    t.endBatch!();
    assert.deepEqual(log, ["a:cork", "a:1,1", "a:2", "a:uncork", "b:cork", "b:3", "b:uncork"]);
    // After the batch, sends are immediate again.
    a.send(Uint8Array.of(4));
    assert.equal(log[log.length - 1], "a:4");
  });

  it("publish flushes held sends first so it cannot overtake them", async () => {
    const { t, log, open } = await rig(true);
    const a = open("a");
    t.beginBatch!();
    a.send(Uint8Array.of(1));
    t.publish("t", Uint8Array.of(7));
    t.endBatch!();
    assert.deepEqual(log, ["a:cork", "a:1", "a:uncork", "pub:t:7"]);
  });

  it("grows past the initial arena and index capacity", async () => {
    const { t, log, open } = await rig(true);
    const a = open("a");
    t.beginBatch!();
    const big = new Uint8Array(1 << 20).fill(5);
    for (let i = 0; i < 5; i++) a.send(big); // > 2 MB arena
    for (let i = 0; i < 5000; i++) a.send(Uint8Array.of(i & 0xff)); // > 4096 entries
    t.endBatch!();
    assert.equal(log.length, 2 + 5 + 5000);
  });
});
