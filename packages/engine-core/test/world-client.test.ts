import test from "node:test";
import assert from "node:assert/strict";
import {
  WorldClient,
  WorldTransportError,
  type WorldTransport,
} from "../src/world/client.js";

/** Scripted stub: method -> handler. Records every call. */
class StubTransport implements WorldTransport {
  calls: { method: string; args: Record<string, unknown>; token?: string }[] = [];
  handlers = new Map<string, (args: Record<string, unknown>) => Record<string, unknown>>();

  async call(method: string, args: Record<string, unknown>, token?: string) {
    this.calls.push({ method, args, token });
    const h = this.handlers.get(method);
    if (!h) throw new WorldTransportError(501, `${method} not stubbed`);
    return h(args);
  }
}

const RANGE = { x0: 0, x1: 100, z0: 0, z1: 100 };

function makeClient(t: StubTransport, stats = { load: 0.2, tickJitterMs: 1, entityCount: 5 }) {
  return new WorldClient({
    transport: t,
    regionId: "r1",
    chunkRange: RANGE,
    endpoint: "ws://localhost:7777",
    capacity: 100,
    apiKey: "key",
    heartbeatIntervalMs: 60_000, // don't let the timer fire during tests
    getStats: () => stats,
    onError: () => {},
  });
}

test("start registers and stores the lease", async () => {
  const t = new StubTransport();
  t.handlers.set("RegisterRegion", () => ({
    lease: { regionId: "r1", heartbeatIntervalMs: 1000, registryVersion: 1, token: "t".repeat(64) },
  }));
  const c = makeClient(t);
  await c.start();
  assert.equal(c.registered, true);
  assert.equal(c.currentLease?.regionId, "r1");
  const reg = t.calls.find((x) => x.method === "RegisterRegion")!;
  assert.equal((reg.args["input"] as Record<string, unknown>)["regionId"], "r1");
  await c.stop();
});

test("heartbeat sends live stats with the bearer token", async () => {
  const t = new StubTransport();
  const token = "a".repeat(64);
  t.handlers.set("RegisterRegion", () => ({
    lease: { regionId: "r1", heartbeatIntervalMs: 1000, registryVersion: 1, token },
  }));
  t.handlers.set("Heartbeat", () => ({ ack: { ok: true, registryVersion: 1, migrations: [] } }));
  const c = makeClient(t);
  await c.start();
  const ack = await c.heartbeat();
  assert.equal(ack?.ok, true);
  const hb = t.calls.find((x) => x.method === "Heartbeat")!;
  assert.equal(hb.token, token);
  assert.deepEqual(
    (hb.args["input"] as Record<string, unknown>)["entityCount"],
    5,
  );
  await c.stop();
});

test("heartbeat 404/401 triggers re-registration", async () => {
  for (const code of [404, 401]) {
    const t = new StubTransport();
    let tokens = 0;
    t.handlers.set("RegisterRegion", () => {
      tokens += 1;
      return {
        lease: { regionId: "r1", heartbeatIntervalMs: 1000, registryVersion: 1, token: String(tokens).repeat(64).slice(0, 64) },
      };
    });
    t.handlers.set("Heartbeat", () => {
      throw new WorldTransportError(code, `Heartbeat failed: ${code}`);
    });
    const c = makeClient(t);
    await c.start();
    assert.equal(tokens, 1);
    await c.heartbeat();
    assert.equal(tokens, 2, `re-registered after ${code}`);
    assert.equal(c.registered, true);
    await c.stop();
  }
});

test("stop deregisters best-effort and never throws", async () => {
  const t = new StubTransport();
  t.handlers.set("RegisterRegion", () => ({
    lease: { regionId: "r1", heartbeatIntervalMs: 1000, registryVersion: 1, token: "t".repeat(64) },
  }));
  t.handlers.set("DeregisterRegion", () => {
    throw new WorldTransportError(0, "transport error calling DeregisterRegion: boom");
  });
  const errors: unknown[] = [];
  const c = new WorldClient({
    transport: t,
    regionId: "r1",
    chunkRange: RANGE,
    endpoint: "ws://localhost:7777",
    capacity: 100,
    apiKey: "key",
    heartbeatIntervalMs: 60_000,
    onError: (e) => errors.push(e),
  });
  await c.start();
  await c.stop(); // must not throw despite the failing deregister
  assert.equal(c.registered, false);
  assert.equal(t.calls.filter((x) => x.method === "DeregisterRegion").length, 1);
  assert.equal(errors.length, 1);
});

test("start failure keeps the client unregistered but alive", async () => {
  const t = new StubTransport();
  t.handlers.set("RegisterRegion", () => {
    throw new WorldTransportError(0, "connection refused");
  });
  const errors: unknown[] = [];
  const c = new WorldClient({
    transport: t,
    regionId: "r1",
    chunkRange: RANGE,
    endpoint: "ws://localhost:7777",
    capacity: 100,
    apiKey: "key",
    heartbeatIntervalMs: 60_000,
    onError: (e) => errors.push(e),
  });
  await c.start(); // must not throw
  assert.equal(c.registered, false);
  assert.equal(errors.length, 1);
  await c.stop();
});
