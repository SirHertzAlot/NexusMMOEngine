/**
 * TDD: LaggySocket — simulated latency for the mirror client.
 * Wraps a SocketLike, delaying sends and receives by the configured
 * milliseconds. Used by the Play menu's "Simulated latency" option.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LaggySocket } from "../src/laggy-socket.js";
import type { SocketLike } from "../src/socket.js";

function fakeSocket(): SocketLike & { sent: Uint8Array[] } {
  const s = {
    sent: [] as Uint8Array[],
    onmessage: null as ((data: Uint8Array) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as ((err: unknown) => void) | null,
    onopen: null as (() => void) | null,
    send(data: Uint8Array) { s.sent.push(data); },
    close() {},
  };
  return s;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("LaggySocket", () => {
  it("passes through with zero lag", async () => {
    const inner = fakeSocket();
    const laggy = new LaggySocket(inner, 0);
    laggy.send(new Uint8Array([1, 2, 3]));
    await sleep(10);
    assert.equal(inner.sent.length, 1);
  });

  it("delays sends by the lag", async () => {
    const inner = fakeSocket();
    const laggy = new LaggySocket(inner, 50);
    laggy.send(new Uint8Array([1]));
    await sleep(10);
    assert.equal(inner.sent.length, 0, "should not have sent yet");
    await sleep(60);
    assert.equal(inner.sent.length, 1, "should have sent after the lag");
  });

  it("delays receives by the lag", async () => {
    const inner = fakeSocket();
    const laggy = new LaggySocket(inner, 50);
    let received: Uint8Array | null = null;
    laggy.onmessage = (d) => { received = d; };
    inner.onmessage!(new Uint8Array([9]));
    await sleep(10);
    assert.equal(received, null, "should not have received yet");
    await sleep(60);
    assert.ok(received !== null, "should have received after the lag");
  });

  it("forwards close/onclose/onerror/onopen", () => {
    const inner = fakeSocket();
    const laggy = new LaggySocket(inner, 10);
    let closed = false;
    laggy.onclose = () => { closed = true; };
    inner.onclose!();
    assert.equal(closed, true);
    // close() delegates
    let innerClosed = false;
    (inner as { close(): void }).close = () => { innerClosed = true; };
    laggy.close();
    assert.equal(innerClosed, true);
  });
});
