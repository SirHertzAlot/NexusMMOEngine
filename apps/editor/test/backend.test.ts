/**
 * BackendClient + api(): lifecycle, verbs, retries, and HTTP errors.
 *
 * All I/O is faked (no processes, no sockets): the socket factory seam
 * is what is under test, plus the exact admin envelopes the gateway
 * expects (see gateway.ts run*Command usage strings).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  BackendClient,
  api,
  type ClientLike,
} from "../src/backend.js";
import type { HelloAuth, MirrorEvents } from "@mmo-engine/mirror";
import type { AdminResult, DebugResponse } from "@mmo-engine/protocol";

class FakeClient implements ClientLike {
  sessionToken: string | null = null;
  connects = 0;
  disconnects = 0;
  lastAuth: HelloAuth | null = null;
  adminCalls: Array<[string, unknown?]> = [];
  failConnect = 0;
  adminMessage = "ok";
  events: MirrorEvents | null = null;

  async connect(_url: string, _name: string, auth: HelloAuth): Promise<unknown> {
    this.connects++;
    this.lastAuth = auth;
    if (this.failConnect > 0) {
      this.failConnect--;
      throw new Error("fake: refused");
    }
    this.sessionToken = `token-${this.connects}`;
    return {};
  }

  disconnect(): void {
    this.disconnects++;
    this.events?.onClose();
  }

  async admin(command: string, args?: unknown): Promise<AdminResult> {
    this.adminCalls.push([command, args]);
    return { kind: "admin", command, ok: true, message: this.adminMessage };
  }

  async debug(): Promise<DebugResponse> {
    throw new Error("fake: no debug rows");
  }
}

interface Rig {
  fakes: FakeClient[];
  factory: (events: MirrorEvents) => ClientLike;
  rec: { ticks: number[]; closes: boolean[]; reconnects: number[]; errors: Error[] };
}

function rig(): Rig {
  const fakes: FakeClient[] = [];
  const rec = { ticks: [] as number[], closes: [] as boolean[], reconnects: [] as number[], errors: [] as Error[] };
  return {
    fakes,
    factory: (events: MirrorEvents) => {
      const f = new FakeClient();
      f.events = events;
      fakes.push(f);
      return f;
    },
    rec,
  };
}

function eventsOf(r: Rig) {
  return {
    onTick: (t: number) => void r.rec.ticks.push(t),
    onClose: (willRetry: boolean) => void r.rec.closes.push(willRetry),
    onReconnect: (n: number) => void r.rec.reconnects.push(n),
    onError: (e: Error) => void r.rec.errors.push(e),
  };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const AUTH: HelloAuth = { username: "editor", password: "dev-password-123" };
const open: BackendClient[] = [];

afterEach(() => {
  open.splice(0).forEach((b) => b.stop());
});

function track(b: BackendClient): BackendClient {
  open.push(b);
  return b;
}

describe("BackendClient", () => {
  it("connects, reports ticks, and keeps the session token", async () => {
    const r = rig();
    const b = track(await BackendClient.connect("ws://127.0.0.1:7777", AUTH, eventsOf(r), { createClient: r.factory }));
    assert.equal(b.state, "live");
    assert.equal(b.sessionToken, "token-1");
    r.fakes[0].events?.onState(42);
    assert.deepEqual(r.rec.ticks, [42]);
    b.stop();
    assert.equal(b.state, "idle");
  });

  it("verbs send the gateway's exact admin envelopes", async () => {
    const r = rig();
    const b = track(await BackendClient.connect("ws://127.0.0.1:7777", AUTH, eventsOf(r), { createClient: r.factory }));
    const f = r.fakes[0];
    f.adminMessage = "spawned goblin as 3";
    assert.equal(await BackendClient.assertAdminOk(await b.spawn("goblin", { x: 1, z: 2 })), "spawned goblin as 3");
    await b.inspect();
    await b.set("me", "Health", "current", 74);
    await b.teleport(3, 4);
    await b.heal();
    await b.spawnlist();
    await b.despawn("99");
    await b.give();
    await b.loot(3);
    await b.items({ base: "sword" });
    assert.deepEqual(f.adminCalls, [
      ["spawn", { asset: "goblin", x: 1, z: 2 }],
      ["inspect", { entity: "me" }],
      ["set", { entity: "me", component: "Health", field: "current", value: 74 }],
      ["teleport", { x: 3, z: 4 }],
      ["heal", {}],
      ["spawnlist", undefined],
      ["despawn", { entity: "99" }],
      ["give", {}],
      ["loot", { count: 3 }],
      ["items", { base: "sword" }],
    ]);
    b.stop();
  });

  it("assertAdminOk throws the server's refusal message", () => {
    assert.throws(
      () => BackendClient.assertAdminOk({ kind: "admin", command: "spawn", ok: false, message: "usage: spawn {asset, x?, z?, yaw?}" }),
      /usage: spawn/,
    );
  });

  it("verbs before connect throw instead of hanging", async () => {
    const r = rig();
    const b = track(new BackendClient("ws://127.0.0.1:7777", AUTH, eventsOf(r), { createClient: r.factory }));
    await assert.rejects(() => b.spawn("goblin"), /not connected/);
    b.stop();
  });

  it("a failed first hello rejects start like connectMirror", async () => {
    const r = rig();
    const b = track(new BackendClient("ws://127.0.0.1:7777", AUTH, eventsOf(r), {
      createClient: (ev) => {
        const f = r.factory(ev);
        (f as FakeClient).failConnect = 1;
        return f;
      },
    }));
    await assert.rejects(() => b.start(), /refused/);
    assert.equal(b.state, "idle");
  });

  it("a dropped socket retries with token reattach", async () => {
    const r = rig();
    const b = track(await BackendClient.connect("ws://127.0.0.1:7777", AUTH, eventsOf(r), { createClient: r.factory }));
    assert.equal(r.fakes[0].lastAuth, AUTH);
    r.fakes[0].disconnect();
    await until(() => r.fakes.length === 2 && b.state === "live");
    assert.deepEqual(r.fakes[1].lastAuth, { token: "token-1" });
    assert.deepEqual(r.rec.reconnects, [1]);
    assert.deepEqual(r.rec.closes, [true]);
    b.stop();
  });

  it("stop() ends the retry loop", async () => {
    const r = rig();
    const b = track(await BackendClient.connect("ws://127.0.0.1:7777", AUTH, eventsOf(r), { createClient: r.factory }));
    b.stop();
    assert.equal(r.fakes.length, 1);
    assert.deepEqual(r.rec.closes, [false]);
  });

  it("the staleness watchdog reconnects a quiet socket", async () => {
    const r = rig();
    const b = track(
      await BackendClient.connect("ws://127.0.0.1:7777", AUTH, eventsOf(r), { createClient: r.factory, staleAfterMs: 30 }),
    );
    await until(() => r.fakes.length === 2 && b.state === "live");
    b.stop();
  });
});

describe("api", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns decoded bodies", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, pid: 4242 }),
    })) as unknown as typeof fetch;
    const body = await api<{ ok: boolean; pid: number }>("/api/editor/server/status");
    assert.deepEqual(body, { ok: true, pid: 4242 });
  });

  it("throws the host's refusal message", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: "boom" }),
    })) as unknown as typeof fetch;
    await assert.rejects(() => api("/api/editor/server/start"), /boom/);
  });

  it("falls back to the HTTP status on empty bodies", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error("no json");
      },
    })) as unknown as typeof fetch;
    await assert.rejects(() => api("/api/editor/server/start"), /HTTP 503/);
  });
});
