/**
 * PlayModeController: lifecycle, ownership, and state restoration.
 *
 * All I/O is faked (no processes, no sockets): the state machine,
 * the only-stop-what-you-started rule, and the always-restore rule
 * are what is under test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PlayModeController,
  type PlayClient,
  type PlayModeHooks,
  type PlayModeState,
  type PlayServer,
  type ServerControl,
} from "../src/play-mode.js";
import type { DebugResponse } from "@mmo-engine/protocol";

class FakeServer implements ServerControl {
  started = 0;
  stopped = 0;
  failStart = false;
  failStop = false;
  lastOpts: { bots?: number } | undefined;
  /** When set, start() waits for release() before resolving. */
  gate: Promise<void> | null = null;
  private live = false;

  async start(opts?: { bots?: number }): Promise<PlayServer> {
    this.started++;
    this.lastOpts = opts;
    if (this.failStart) throw new Error("fake: spawn failed");
    if (this.gate) await this.gate;
    this.live = true;
    return {
      url: "ws://127.0.0.1:7777",
      pid: 4242,
      username: "editor-fake",
      password: "fake-password-123",
    };
  }
  async stop(): Promise<void> {
    this.stopped++;
    if (this.failStop) throw new Error("fake: kill failed");
    this.live = false;
  }
  isRunning(): boolean {
    return this.live;
  }
}

class FakeClient implements PlayClient {
  disconnected = 0;
  failDisconnect = false;
  async debug(): Promise<DebugResponse> {
    return { kind: "debug", query: "tiles", tiles: [] };
  }
  disconnect(): void {
    this.disconnected++;
    if (this.failDisconnect) throw new Error("fake: disconnect failed");
  }
}

interface Harness {
  controller: PlayModeController;
  server: FakeServer;
  client: FakeClient;
  states: PlayModeState[];
  entered: number;
  exited: unknown[];
  failConnect: boolean;
}

function makeHarness(): Harness {
  const server = new FakeServer();
  const client = new FakeClient();
  const h: Harness = {
    controller: null as unknown as PlayModeController,
    server,
    client,
    states: [],
    entered: 0,
    exited: [],
    failConnect: false,
  };
  const hooks: PlayModeHooks = {
    onEnterPlay: () => {
      h.entered++;
      return { selection: "entity-7" };
    },
    onExitPlay: (saved) => {
      h.exited.push(saved);
    },
    onStateChange: (s) => {
      h.states.push(s);
    },
  };
  h.controller = new PlayModeController(
    server,
    async () => {
      if (h.failConnect) throw new Error("fake: connect failed");
      return client;
    },
    hooks,
  );
  return h;
}

describe("PlayModeController", () => {
  it("start → running → stop → idle, with state events and restoration", async () => {
    const h = makeHarness();
    await h.controller.start();
    assert.equal(h.controller.getState(), "running");
    assert.deepEqual(h.controller.serverInfo, {
      url: "ws://127.0.0.1:7777",
      pid: 4242,
      username: "editor-fake",
      password: "fake-password-123",
    });
    assert.equal(h.entered, 1);
    assert.deepEqual(h.states, ["starting", "running"]);

    await h.controller.stop();
    assert.equal(h.controller.getState(), "idle");
    assert.equal(h.server.stopped, 1);
    assert.equal(h.client.disconnected, 1);
    // Pre-play editor state restored exactly once with the saved snapshot.
    assert.deepEqual(h.exited, [{ selection: "entity-7" }]);
    assert.deepEqual(h.states, ["starting", "running", "stopping", "idle"]);
  });

  it("failed server start cleans up and restores (error state)", async () => {
    const h = makeHarness();
    h.server.failStart = true;
    await assert.rejects(h.controller.start(), /spawn failed/);
    assert.equal(h.controller.getState(), "error");
    assert.equal(h.server.started, 1);
    assert.equal(h.server.stopped, 0, "nothing live to stop");
    assert.deepEqual(h.exited, [{ selection: "entity-7" }]);
    // Recoverable: a later start works from error.
    h.server.failStart = false;
    await h.controller.start();
    assert.equal(h.controller.getState(), "running");
    await h.controller.stop();
  });

  it("failed client connect stops the owned server and restores", async () => {
    const h = makeHarness();
    h.failConnect = true;
    await assert.rejects(h.controller.start(), /connect failed/);
    assert.equal(h.controller.getState(), "error");
    assert.equal(h.server.stopped, 1, "owned server is stopped");
    assert.equal(h.server.isRunning(), false);
    assert.deepEqual(h.exited, [{ selection: "entity-7" }]);
  });

  it("stop attempts every step even when disconnect throws", async () => {
    const h = makeHarness();
    await h.controller.start();
    h.client.failDisconnect = true;
    await assert.rejects(h.controller.stop(), /disconnect failed/);
    assert.equal(h.server.stopped, 1, "server still stopped");
    assert.deepEqual(h.exited, [{ selection: "entity-7" }]);
    assert.equal(h.controller.getState(), "idle");
  });

  it("debug queries require the running state", async () => {
    const h = makeHarness();
    await assert.rejects(h.controller.debugTiles(), /not running/);
    await h.controller.start();
    const res = await h.controller.debugTiles();
    assert.equal(res.query, "tiles");
    await h.controller.stop();
    await assert.rejects(h.controller.debugTiles(), /not running/);
  });

  it("double start is a no-op; stop when idle is a no-op", async () => {
    const h = makeHarness();
    await h.controller.start();
    await h.controller.start();
    assert.equal(h.server.started, 1);
    await h.controller.stop();
    await h.controller.stop();
    assert.equal(h.server.stopped, 1);
  });

  it("start forwards play options (bots) to the server control", async () => {
    const h = makeHarness();
    await h.controller.start({ bots: 50 });
    assert.deepEqual(h.server.lastOpts, { bots: 50 });
    assert.equal(h.controller.getState(), "running");
    await h.controller.stop();
  });

  it("stop during starting aborts: idle, server cleaned up, no orphan run", async () => {
    const h = makeHarness();
    let release!: () => void;
    h.server.gate = new Promise<void>((r) => (release = r));
    const starting = h.controller.start();
    // Let start() reach the gated server start.
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(h.controller.getState(), "starting");
    await h.controller.stop();
    assert.equal(h.controller.getState(), "idle");
    release();
    await starting;
    assert.equal(h.controller.getState(), "idle", "no flip back to running");
    assert.equal(h.server.stopped, 1, "late server is stopped");
    assert.equal(h.server.isRunning(), false);
    assert.deepEqual(h.exited, [{ selection: "entity-7" }]);
    assert.deepEqual(h.states, ["starting", "stopping", "idle"]);
  });
});

describe("PlayModeController: simulate (no client)", () => {
  it("runs the server without connecting a client, and stops it", async () => {
    const server = new FakeServer();
    let connects = 0;
    const c = new PlayModeController(
      server,
      async () => {
        connects++;
        return new FakeClient();
      },
      { onEnterPlay: () => null, onExitPlay: () => undefined, onStateChange: () => undefined },
    );
    await c.start({ noClient: true });
    assert.equal(c.getState(), "running");
    assert.equal(connects, 0);
    // Debug queries need a client: they refuse instead of hanging.
    await assert.rejects(() => c.debugTiles(), /not running/);
    await c.stop();
    assert.equal(c.getState(), "idle");
    assert.equal(server.stopped, 1);
  });
});

describe("PlayModeController: extra clients", () => {
  const make = (failAt = -1) => {
    const server = new FakeServer();
    const asked: number[] = [];
    const clients: FakeClient[] = [];
    const details: Array<string | undefined> = [];
    const c = new PlayModeController(
      server,
      async (_s, index) => {
        asked.push(index);
        if (index === failAt) throw new Error("login refused");
        const fc = new FakeClient();
        clients.push(fc);
        return fc;
      },
      { onEnterPlay: () => null, onExitPlay: () => undefined, onStateChange: (_st, d) => details.push(d) },
    );
    return { c, server, asked, clients, details };
  };

  it("connects each client with its own index, and stop disconnects them all", async () => {
    const h = make();
    await h.c.start({ clients: 4 });
    assert.deepEqual(h.asked, [0, 1, 2, 3]);
    await h.c.stop();
    assert.deepEqual(h.clients.map((x) => x.disconnected), [1, 1, 1, 1]);
  });

  it("a failed extra client still runs, and says how many connected", async () => {
    const h = make(2);
    await h.c.start({ clients: 4 });
    assert.equal(h.c.getState(), "running");
    assert.deepEqual(h.asked, [0, 1, 2]);
    assert.match(h.details.at(-1) ?? "", /2 of 4 clients connected \(login refused\)/);
    await h.c.stop();
  });
});
