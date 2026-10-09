/** The simulated-latency proxy (EA14): data arrives intact and in order, one round trip later. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { startLatencyProxy } from "../src/latency-proxy.js";

async function echo(): Promise<{ port: number; close(): void }> {
  const server = createServer((s) => s.pipe(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => server.close() };
}

function roundTrip(port: number, message: string): Promise<{ ms: number; got: string }> {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1");
    let got = "";
    const t0 = Date.now();
    s.on("connect", () => s.write(message));
    s.on("data", (d) => {
      got += d.toString();
      if (got.length >= message.length) {
        s.destroy();
        resolve({ ms: Date.now() - t0, got });
      }
    });
    s.on("error", reject);
  });
}

describe("latency proxy", () => {
  it("adds the round trip to a connection (handshake included) and keeps the bytes", async () => {
    const target = await echo();
    const direct = await roundTrip(target.port, "hello");
    const proxy = await startLatencyProxy({ host: "127.0.0.1", port: target.port }, 200);
    const slow = await roundTrip(proxy.port, "hello world, in order");
    assert.equal(slow.got, "hello world, in order");
    // connect is not delayed (TCP), the request and the echo are: ~200 ms; allow timer slack both ways.
    assert.ok(slow.ms >= 180, `took ${slow.ms} ms`);
    assert.ok(slow.ms - direct.ms >= 150, `only ${slow.ms - direct.ms} ms slower than direct`);
    await proxy.close();
    target.close();
  });

  it("keeps many writes in order", async () => {
    const target = await echo();
    const proxy = await startLatencyProxy({ host: "127.0.0.1", port: target.port }, 40);
    const msg = Array.from({ length: 50 }, (_, i) => `[${i}]`).join("");
    const out = await new Promise<string>((resolve) => {
      const s = connect(proxy.port, "127.0.0.1");
      let got = "";
      s.on("connect", async () => {
        for (let i = 0; i < 50; i++) {
          s.write(`[${i}]`);
          await new Promise((r) => setImmediate(r));
        }
      });
      s.on("data", (d) => {
        got += d.toString();
        if (got.length >= msg.length) {
          s.destroy();
          resolve(got);
        }
      });
    });
    assert.equal(out, msg);
    await proxy.close();
    target.close();
  });
});
