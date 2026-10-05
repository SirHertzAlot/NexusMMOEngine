/**
 * View-data contracts: every center view declares its expected backend
 * data (and every backend source has a view), plus the text-protocol
 * parsers and their typed BackendClient accessors.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BACKEND_SOURCES,
  VIEW_DATA_CONTRACT,
  parseInspectEntity,
  parseTelemetrySnapshot,
  type ViewKey,
} from "../src/backend-models.js";
import { BackendClient, type ClientLike } from "../src/backend.js";
import type { HelloAuth } from "@mmo-engine/mirror";
import type { AdminResult } from "@mmo-engine/protocol";

/** All 22 center views (workspace/view), mirroring App.tsx WORKSPACES. */
const ALL_VIEWS: ViewKey[] = [
  "world/terrain",
  "scene/ecs",
  "flow/flow",
  "flow/hud",
  "characters/records",
  "gameplay/tables",
  "gameplay/rules",
  "dungeons/dungeons",
  "dungeons/graphs",
  "liveops/overview",
  "network/network",
  "debug/play",
  "database/grid",
  "database/query",
  "story/quests",
  "story/strings",
  "artaudio/assets",
  "artaudio/animation",
  "artaudio/vfx",
  "artaudio/audio",
  "release/pipeline",
  "release/playtests",
];

describe("VIEW_DATA_CONTRACT covers every view", () => {
  it("has an entry for all 22 center views, keyed by view", () => {
    assert.deepEqual(Object.keys(VIEW_DATA_CONTRACT).sort(), [...ALL_VIEWS].sort());
    for (const key of ALL_VIEWS) {
      const b = VIEW_DATA_CONTRACT[key];
      assert.equal(b.view, key);
      assert.match(b.label, /./);
      assert.match(b.expects, /./);
      assert.match(b.via, /./);
      assert.ok(
        (["live", "parsed", "staged", "local"] as const).includes(b.status),
        `${key} has unknown status ${b.status}`,
      );
    }
  });

  it("every backend source is expected by at least one view (no orphans)", () => {
    const haystacks = Object.values(VIEW_DATA_CONTRACT).map((b) => `${b.expects} ${b.via}`);
    for (const source of BACKEND_SOURCES) {
      assert.ok(
        haystacks.some((h) => h.includes(source)),
        `backend source ${source} has no view`,
      );
    }
  });
});

const TELEMETRY_JSON = JSON.stringify({
  bucketSeconds: 10,
  buckets: 3,
  series: { kills: [0, 1, 2], deaths: [0, 0, 1] },
  totals: { kills: 3 },
  tick: { count: 1200, p50Ms: 2.1, p99Ms: 8.4, maxMs: 12 },
});

describe("parseTelemetrySnapshot", () => {
  it("parses the stats JSON into typed telemetry", () => {
    const t = parseTelemetrySnapshot(TELEMETRY_JSON);
    assert.equal(t.bucketSeconds, 10);
    assert.deepEqual(t.series["kills"], [0, 1, 2]);
    assert.equal(t.totals["kills"], 3);
    assert.equal(t.tick.p99Ms, 8.4);
  });

  it("rejects non-JSON and shapeless payloads", () => {
    assert.throws(() => parseTelemetrySnapshot("kills: 3"), /non-JSON/);
    assert.throws(() => parseTelemetrySnapshot("{}"), /missing/);
    assert.throws(() => parseTelemetrySnapshot(JSON.stringify({ tick: {} })), /missing/);
    assert.throws(
      () => parseTelemetrySnapshot(JSON.stringify({
        bucketSeconds: 10,
        buckets: 1,
        series: {},
        totals: {},
        tick: { count: 1, p50Ms: 1, p99Ms: "x", maxMs: 1 },
      })),
      /tick\.p99Ms/,
    );
  });
});

const INSPECT_DUMP = [
  "entity 12345 (slot 7)",
  "Transform: pos 1.5 2 3.25 rot 0 0 0 1",
  "Velocity: lin 0.1 0 0",
  "PlayerIntent: move 0 0 1 look 1.57 0 jump 0 buttons 2",
  "Chunk: id 987654321 lod 0",
  "Health: 80/100",
  "BodyConfig: shape 2 motion 2 mass 70",
  "PathRequest: to 10.5 20.5 profile 0 token 3",
  "PathState: status 1 token 3 waypoints 5",
  "NavAgent: target 1 2 3 state 2",
  "AssetRef: hash 123456 variant 1",
  "Locomotion: mode 0 abilities 3 breath 1",
  'Appearance: {"gender":"male","parts":{},"colours":{}}',
  "Action: move 1 started 999 seq 2",
  "Stats: swords=22 standing=15",
  "Mystery: something unknown here",
].join("\n");

describe("parseInspectEntity", () => {
  it("parses the exact engine dump format", () => {
    const e = parseInspectEntity(INSPECT_DUMP);
    assert.equal(e.wireId, "12345");
    assert.equal(e.slot, 7);
    assert.deepEqual(e.transform, { pos: [1.5, 2, 3.25], rot: [0, 0, 0, 1] });
    assert.deepEqual(e.velocity, { lin: [0.1, 0, 0] });
    assert.deepEqual(e.intent, { move: [0, 0, 1], lookYaw: 1.57, lookPitch: 0, jump: 0, buttons: 2 });
    assert.deepEqual(e.chunk, { id: "987654321", lod: 0 });
    assert.deepEqual(e.health, { current: 80, max: 100 });
    assert.deepEqual(e.body, { shape: 2, motion: 2, mass: 70 });
    assert.deepEqual(e.pathRequest, { x: 10.5, z: 20.5, profile: 0, token: 3 });
    assert.deepEqual(e.pathState, { status: "1", token: 3, waypoints: 5 });
    assert.deepEqual(e.navAgent, { target: [1, 2, 3], state: 2 });
    assert.deepEqual(e.asset, { hash: 123456, variant: 1 });
    assert.deepEqual(e.locomotion, { mode: 0, abilities: 3, breath: 1 });
    assert.deepEqual(e.appearance, { look: { gender: "male", parts: {}, colours: {} } });
    assert.deepEqual(e.action, { move: 1, started: 999, seq: 2 });
    assert.deepEqual(e.stats, { swords: 22, standing: 15 });
    assert.deepEqual(e.extra, { Mystery: "something unknown here" });
  });

  it("requires the header and quarantines malformed lines", () => {
    assert.throws(() => parseInspectEntity("Health: 1/2"), /header/);
    const e = parseInspectEntity("entity 1 (slot 0)\nHealth: lots");
    assert.equal(e.wireId, "1");
    assert.equal(e.health, undefined);
    assert.deepEqual(e.extra, { Health: "lots" });
  });
});

class FakeAdmin implements ClientLike {
  sessionToken: string | null = "token";
  message = "";
  lastCommand = "";
  async connect(): Promise<unknown> {
    return {};
  }
  disconnect(): void {}
  async admin(command: string): Promise<AdminResult> {
    this.lastCommand = command;
    return { kind: "admin", command, ok: true, message: this.message };
  }
  async debug(): Promise<never> {
    throw new Error("fake: no debug rows");
  }
}

function liveBackend(message: string): { client: BackendClient; fake: FakeAdmin } {
  const fake = new FakeAdmin();
  fake.message = message;
  const client = new BackendClient(
    "ws://fake",
    { username: "u", password: "password12" } as HelloAuth,
    { onTick: () => {}, onClose: () => {}, onReconnect: () => {}, onError: () => {} },
    {},
    () => fake,
  );
  // Bypass connect: tests target the verb layer, covered in backend.test.ts.
  (client as unknown as { client: ClientLike; state: string }).client = fake;
  (client as unknown as { state: string }).state = "live";
  return { client, fake };
}

describe("typed BackendClient accessors", () => {
  it("statsSnapshot parses stats JSON", async () => {
    const { client, fake } = liveBackend(TELEMETRY_JSON);
    const t = await client.statsSnapshot();
    assert.equal(fake.lastCommand, "stats");
    assert.equal(t.tick.count, 1200);
  });

  it("inspectEntity parses the dump", async () => {
    const { client, fake } = liveBackend(INSPECT_DUMP);
    const e = await client.inspectEntity("12345");
    assert.equal(fake.lastCommand, "inspect");
    assert.deepEqual(e.health, { current: 80, max: 100 });
  });

  it("refusals throw before parsing", async () => {
    const { client } = liveBackend("");
    const refusing = new FakeAdmin();
    refusing.admin = async (command: string): Promise<AdminResult> => ({
      kind: "admin",
      command,
      ok: false,
      message: "admin only",
    });
    (client as unknown as { client: ClientLike }).client = refusing;
    await assert.rejects(client.statsSnapshot(), /refused: admin only/);
    await assert.rejects(client.inspectEntity(), /refused: admin only/);
  });
});
