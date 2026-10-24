/**
 * SurrealWorldStore connect timeout (fake mode — no live DB).
 *
 * The SurrealDB JS SDK's `connect()` can pend indefinitely on an
 * unreachable server: verified pre-fix with a plain
 * `new Surreal().connect(url)` + 3s watchdog against both
 * `ws://10.255.255.1:8000/rpc` and a silent local TCP socket — the
 * promise never settled in either case.
 *
 * The dead-end target used here is the silent local TCP socket: a
 * node:net server that accepts the connection and never sends a
 * byte, so the SDK's WebSocket handshake never completes. It pends
 * deterministically without depending on sandbox network behavior
 * for unroutable addresses. `connect()` must reject with the typed
 * WorldStoreConnectTimeoutError instead of hanging.
 */
import test from "node:test";
import assert from "node:assert/strict";
import net, { type AddressInfo, type Socket } from "node:net";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  SurrealWorldStore,
  WorldStoreConnectTimeoutError,
} from "../src/surreal-store.js";

/** A listening TCP server that accepts connections and stays silent. */
async function silentServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    // Deliberately never write: the ws handshake can never complete.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/rpc`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function makeStore(url: string, connectTimeoutMs: number): SurrealWorldStore {
  return new SurrealWorldStore({
    url,
    namespace: "mmo",
    database: "world",
    connectTimeoutMs,
  });
}

test("connect() to a dead-end server rejects with WorldStoreConnectTimeoutError instead of hanging", async () => {
  const dead = await silentServer();
  try {
    const store = makeStore(dead.url, 250);
    const started = Date.now();
    await assert.rejects(store.connect(), (err: unknown) => {
      assert.ok(
        err instanceof WorldStoreConnectTimeoutError,
        `expected WorldStoreConnectTimeoutError, got ${String(err)}`,
      );
      assert.match((err as Error).message, /250 ms/);
      assert.ok((err as Error).message.includes(dead.url));
      return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 5000,
      `connect() took ${elapsed} ms — it must time out, not hang`,
    );
    // The store is not poisoned by the timed-out attempt: close()
    // (against the fresh replacement client) resolves cleanly.
    await store.close();
  } finally {
    await dead.close();
  }
});

test("connect() honors a different small timeout with the same typed error", async () => {
  const dead = await silentServer();
  try {
    const store = makeStore(dead.url, 50);
    const started = Date.now();
    await assert.rejects(store.connect(), WorldStoreConnectTimeoutError);
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 5000,
      `connect() took ${elapsed} ms — it must time out, not hang`,
    );
    await store.close();
  } finally {
    await dead.close();
  }
});

test("DEFAULT_CONNECT_TIMEOUT_MS is 10 seconds", () => {
  assert.equal(DEFAULT_CONNECT_TIMEOUT_MS, 10_000);
});
