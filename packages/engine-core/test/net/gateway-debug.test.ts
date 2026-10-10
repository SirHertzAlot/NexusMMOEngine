/**
 * Gateway 0x0a debug queries (editor-only, read-only).
 *
 * - `waypoints`: unknown entity → "unknown"; entity with no request →
 *   "idle"; entity with an active mock-backed path → "active" with the
 *   canned waypoints; malformed entity id → "unknown".
 * - `tiles`: answers with the injected DebugSource ([] when absent).
 * - debug before hello → 4003; malformed JSON → 4003; unknown query → 4003.
 * - Read-only guarantee: answering queries never mutates component state.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import {
  decodeControl,
  encodeControl,
  encodeEnvelope,
  MessageType,
  PROTOCOL_VERSION,
  type DebugQuery,
  type DebugResponse,
  type ErrorMessage,
} from "@mmo-engine/protocol";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import {
  makeDebugSource,
  type DebugSource,
} from "../../src/net/debug-source.js";
import { SimWorld } from "../../src/world.js";
import { HeadlessClient, type HelloAuth } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";
import * as C from "../../src/components.js";
import { NavigationSystem } from "../../src/navigation/system.js";
import {
  NAV_PATH_STATUS,
  type BakeTileConfig,
  type BakeTileResult,
  type FindPathsInput,
  type FindPathsOutput,
  type NavigationBackend,
} from "../../src/navigation/backend.js";

/** Mock backend: answers Ok with a canned 2-point path. */
class MockBackend implements NavigationBackend {
  bakeTile(): BakeTileResult {
    throw new Error("not used");
  }
  loadTiles() {
    return new BigUint64Array(0);
  }
  unloadTiles() {}
  tileCount() {
    return 0;
  }
  findPaths(input: FindPathsInput, output: FindPathsOutput): void {
    for (let i = 0; i < input.count; i++) {
      output.status[i] = NAV_PATH_STATUS.Ok;
      output.waypointCount[i] = 2;
      output.polyCount[i] = 1;
      const o = i * C.MAX_PATH_WAYPOINTS * 3;
      output.waypoints[o] = 1;
      output.waypoints[o + 1] = 0;
      output.waypoints[o + 2] = 2;
      output.waypoints[o + 3] = 3;
      output.waypoints[o + 4] = 0;
      output.waypoints[o + 5] = 4;
    }
  }
  destroy() {}
}

/**
 * Compose a debug source over an explicit world + nav — the same shape
 * the production server builds (see src/server.ts). Tests own the world
 * so waypoint assertions can inspect it directly.
 */
function debugFor(
  world: SimWorld,
  navigation: NavigationSystem | null,
  tiles: Array<[number, number, number, number]> = [],
): DebugSource {
  return makeDebugSource({
    world,
    navigation,
    loadedTileBounds: () => tiles,
  });
}

const STEP_MS = 1000 / 30;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const settle = (): Promise<void> => sleep(50);

let now = 0;
const gateways: Gateway[] = [];

async function startGateway(opts: GatewayOptions = {}): Promise<string> {
  now = 1_000_000;
  const g = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    ...opts,
  });
  gateways.push(g);
  const port = await g.listen();
  g.frame(now);
  return `ws://127.0.0.1:${port}`;
}

function frames(n: number): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    gateways[gateways.length - 1]!.frame(now);
  }
}

const creds = (username: string): HelloAuth => ({
  username,
  password: TEST_PASSWORD,
});

async function join(
  url: string,
  name: string,
): Promise<{ client: HeadlessClient; entity: string }> {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  const welcome = await client.hello(name, creds("alice"));
  assert.equal(welcome.protocol, PROTOCOL_VERSION);
  await snapP;
  return { client, entity: welcome.player_entity };
}

async function debugQuery(
  client: HeadlessClient,
  q: DebugQuery,
): Promise<DebugResponse> {
  const p = client.waitFor(MessageType.Debug, 1);
  client.sendRaw(MessageType.Debug, encodeControl(q));
  const [payload] = await p;
  return decodeControl<DebugResponse>(payload);
}

async function debugError(client: HeadlessClient, raw: Uint8Array): Promise<ErrorMessage> {
  const p = client.waitFor(MessageType.Error, 1);
  client.sendRaw(MessageType.Debug, raw);
  const [payload] = await p;
  return decodeControl<ErrorMessage>(payload);
}

afterEach(async () => {
  while (gateways.length > 0) {
    await gateways.pop()!.close();
  }
});

describe("gateway: 0x0a debug queries", () => {
  it("timings: tick count, p50/p99 and each system's cost", async () => {
    const world = new SimWorld();
    const busy = {
      name: "busy-test-system",
      step: () => {
        const until = performance.now() + 0.2;
        while (performance.now() < until) {
          /* spend a measurable slice */
        }
      },
    };
    const url = await startGateway({ world, systems: [busy] });
    const { client } = await join(url, "dbg-timings");
    try {
      frames(5);
      const res = await debugQuery(client, { kind: "debug", query: "timings" });
      assert.equal(res.query, "timings");
      if (res.query === "timings") {
        assert.ok(res.ticks >= 5, `ticks=${res.ticks}`);
        assert.ok(res.p99 >= res.p50);
        const sys = res.systems.find((x) => x.name === "busy-test-system");
        assert.ok(sys, `systems: ${res.systems.map((x) => x.name).join(", ")}`);
        assert.ok(sys.avg > 0 && sys.max >= sys.avg);
      }
    } finally {
      await client.close();
    }
  });

  it("waypoints: unknown entity → unknown; idle entity → idle, no waypoints", async () => {
    const world = new SimWorld();
    const nav = new NavigationSystem({ backend: new MockBackend() });
    const url = await startGateway({
      world,
      systems: [nav],
      debugSource: debugFor(world, nav, [[0, 0, 16, 16]]),
    });
    const { client, entity } = await join(url, "dbg-1");
    try {
      const unk = await debugQuery(client, {
        kind: "debug",
        query: "waypoints",
        entity: "999999",
      });
      assert.equal(unk.query, "waypoints");
      if (unk.query === "waypoints") {
        assert.equal(unk.status, "unknown");
        assert.deepEqual(unk.waypoints, []);
      }

      // The player's own entity exists but has no path request → idle.
      const idle = await debugQuery(client, {
        kind: "debug",
        query: "waypoints",
        entity,
      });
      assert.equal(idle.query, "waypoints");
      if (idle.query === "waypoints") {
        assert.equal(idle.status, "idle");
        assert.deepEqual(idle.waypoints, []);
      }
    } finally {
      await client.close();
    }
  });

  it("waypoints: active path returns the server waypoints", async () => {
    const world = new SimWorld();
    const nav = new NavigationSystem({ backend: new MockBackend() });
    const url = await startGateway({
      world,
      systems: [nav],
      debugSource: debugFor(world, nav),
    });
    const { client } = await join(url, "dbg-2");
    try {
      // Issue a real PathRequest on the server world for the player entity,
      // then tick so NavigationSystem resolves it via the mock backend.
      const world = gateways[gateways.length - 1]!.world;
      const eid = world.spawn();
      addComponent(world.ecs, C.Transform, eid);
      addComponent(world.ecs, C.PathRequest, eid);
      addComponent(world.ecs, C.PathState, eid);
      C.Transform.px[eid] = 0;
      C.Transform.py[eid] = 0;
      C.Transform.pz[eid] = 0;
      C.PathRequest.x[eid] = 10;
      C.PathRequest.z[eid] = 10;
      C.PathRequest.profile[eid] = 0;
      C.PathRequest.token[eid] = 7;
      frames(2);
      await settle();

      const wid = world.wireId(eid).toString();
      const res = await debugQuery(client, {
        kind: "debug",
        query: "waypoints",
        entity: wid,
      });
      assert.equal(res.query, "waypoints");
      if (res.query === "waypoints") {
        assert.equal(res.status, "active");
        assert.deepEqual(res.waypoints, [
          [1, 0, 2],
          [3, 0, 4],
        ]);
      }
    } finally {
      await client.close();
    }
  });

  it("tiles: answers with the injected provider ([] when absent)", async () => {
    const world = new SimWorld();
    const url = await startGateway({
      world,
      debugSource: debugFor(world, null, [
        [0, 0, 16, 16],
        [16, 0, 32, 16],
      ]),
    });
    const { client } = await join(url, "dbg-3");
    try {
      const res = await debugQuery(client, { kind: "debug", query: "tiles" });
      assert.equal(res.query, "tiles");
      if (res.query === "tiles") {
        assert.deepEqual(res.tiles, [
          [0, 0, 16, 16],
          [16, 0, 32, 16],
        ]);
      }
    } finally {
      await client.close();
    }

    const url2 = await startGateway();
    const { client: client2 } = await join(url2, "dbg-4");
    try {
      const res = await debugQuery(client2, { kind: "debug", query: "tiles" });
      assert.equal(res.query, "tiles");
      if (res.query === "tiles") assert.deepEqual(res.tiles, []);
    } finally {
      await client2.close();
    }
  });

  it("debug is read-only: queries never mutate component state", async () => {
    const world = new SimWorld();
    const nav = new NavigationSystem({ backend: new MockBackend() });
    const url = await startGateway({
      world,
      systems: [nav],
      debugSource: debugFor(world, nav),
    });
    const { client } = await join(url, "dbg-5");
    try {
      const world = gateways[gateways.length - 1]!.world;
      const eid = world.spawn();
      addComponent(world.ecs, C.Transform, eid);
      const before = C.Transform.px[eid];
      const wid = world.wireId(eid).toString();
      await debugQuery(client, { kind: "debug", query: "waypoints", entity: wid });
      await debugQuery(client, { kind: "debug", query: "tiles" });
      await debugQuery(client, {
        kind: "debug",
        query: "waypoints",
        entity: "424242",
      });
      assert.equal(C.Transform.px[eid], before);
      assert.equal(C.PathState.status[eid], 0);
    } finally {
      await client.close();
    }
  });

  it("rejects: debug before hello, malformed JSON, unknown query", async () => {
    const url = await startGateway();
    const raw = new HeadlessClient();
    await raw.connect(url);
    try {
      const preHello = await debugError(raw, encodeControl({ kind: "debug", query: "tiles" }));
      assert.equal(preHello.code, 4003);
    } finally {
      await raw.close();
    }

    const { client } = await join(url, "dbg-6");
    try {
      const bad = await debugError(
        client,
        new Uint8Array([0x7b, 0x7b, 0x7b]), // "{{{" — not JSON
      );
      assert.equal(bad.code, 4003);
      const unknownQ = await debugError(
        client,
        encodeControl({ kind: "debug", query: "nope" }),
      );
      assert.equal(unknownQ.code, 4003);
      // The connection survives malformed debug queries: a valid one works.
      const ok = await debugQuery(client, { kind: "debug", query: "tiles" });
      assert.equal(ok.query, "tiles");
    } finally {
      await client.close();
    }
  });
});
