/** ServerLink: stopped state, start via the host route, connect with the status login, live stats, drop when the server goes. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ServerLink, type HostStatus, type LinkClient, type LinkDeps } from "../src/server-link.js";
import type { TelemetrySnapshot } from "../src/backend-models.js";

const SNAP: TelemetrySnapshot = { bucketSeconds: 10, buckets: 60, series: {}, totals: { kills: 2 }, tick: { count: 10, p50Ms: 1, p99Ms: 4, maxMs: 6 } };

function rig(): { link: ServerLink; set(s: HostStatus): void; log: string[]; clock: { t: number }; tick(t: number): void; client: LinkClient & { stopped: boolean } } {
  let status: HostStatus = { running: false };
  const log: string[] = [];
  const clock = { t: 1000 };
  let onTick: (t: number) => void = () => {};
  const client = {
    stopped: false,
    adminRaw: (c: string, a?: unknown) => {
      log.push(`admin ${c} ${JSON.stringify(a ?? null)}`);
      clock.t += 7;
      return c === "boom" ? Promise.reject(new Error("admin only")) : Promise.resolve({ ok: true, message: "ok" });
    },
    statsSnapshot: () => Promise.resolve(SNAP),
    stop() {
      this.stopped = true;
    },
  };
  const deps: LinkDeps = {
    fetchStatus: () => Promise.resolve(status),
    startServer: () => {
      log.push("start");
      status = { running: true, pid: 5, port: 7777, url: "ws://127.0.0.1:7777", username: "u", password: "p" };
      return Promise.resolve();
    },
    connect: (url, user, pass, tick) => {
      log.push(`connect ${url} ${user}/${pass}`);
      onTick = tick;
      return Promise.resolve(client);
    },
    now: () => clock.t,
  };
  return { link: new ServerLink(deps), set: (s) => void (status = s), log, clock, tick: (t) => onTick(t), client };
}

describe("ServerLink", () => {
  it("with no server it is stopped and connects to nothing", async () => {
    const r = rig();
    await r.link.refresh();
    assert.equal(r.link.get().phase, "stopped");
    assert.deepEqual(r.log, []);
  });
  it("start uses the host start route, then connects with the status login and reads stats and ping", async () => {
    const r = rig();
    await r.link.start();
    const s = r.link.get();
    assert.equal(s.phase, "live");
    assert.equal(s.rttMs, 7);
    assert.equal(s.telemetry?.tick.p99Ms, 4);
    assert.deepEqual(r.log.slice(0, 2), ["start", "connect ws://127.0.0.1:7777 u/p"]);
  });
  it("a server the host already owns is connected to, not started a second time", async () => {
    const r = rig();
    r.set({ running: true, pid: 9, port: 7777, url: "ws://127.0.0.1:7777", username: "u", password: "p" });
    await r.link.start();
    assert.equal(r.log.includes("start"), false);
    assert.equal(r.link.get().phase, "live");
  });
  it("does not reconnect on each refresh", async () => {
    const r = rig();
    await r.link.start();
    await r.link.refresh();
    await r.link.refresh();
    assert.equal(r.log.filter((l) => l.startsWith("connect")).length, 1);
  });
  it("measures the tick rate from the tick numbers over wall time", async () => {
    const r = rig();
    await r.link.start();
    r.tick(100);
    r.clock.t += 1000;
    r.tick(130);
    assert.equal(Math.round(r.link.get().tickRate ?? 0), 30);
    assert.equal(r.link.get().lastTick, 130);
  });
  it("drops the link and goes back to stopped when the host says the server is gone", async () => {
    const r = rig();
    await r.link.start();
    r.set({ running: false });
    await r.link.refresh();
    assert.equal(r.link.get().phase, "stopped");
    assert.equal(r.client.stopped, true);
  });
  it("a refused admin command comes back as not ok with the server's words; none without a server", async () => {
    const r = rig();
    assert.deepEqual(await r.link.admin("heal"), { ok: false, message: "server not running" });
    await r.link.start();
    assert.deepEqual(await r.link.admin("boom"), { ok: false, message: "admin only" });
    assert.equal((await r.link.admin("heal")).ok, true);
  });
  it("a failed start is an error state with the host's message", async () => {
    const r = rig();
    const link = new ServerLink({ ...{ fetchStatus: () => Promise.resolve({ running: false }), connect: () => Promise.reject(new Error("x")), now: () => 0 }, startServer: () => Promise.reject(new Error("port busy")) });
    await link.start();
    assert.equal(link.get().phase, "error");
    assert.equal(link.get().error, "port busy");
    assert.ok(r);
  });
});
