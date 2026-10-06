/**
 * Dungeon run ingest (roadmap D4, slice 2): the world records the
 * region's committed runs idempotently by instance id.
 *
 * Seam: WorldCore.reportDungeonResults over the WorldStore boundary
 * (MemoryWorldStore here). Transport (webrpc/RIDL/Zod) is the next slice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as argon2 from "argon2";
import { WorldCoreImpl } from "../src/core.js";
import { MemoryWorldStore } from "../src/fake-store.js";
import { WorldError } from "../src/types.js";

const API_KEY = "test-bootstrap-key-123";
const RANGE = { x0: 0, x1: 100, z0: 0, z1: 100 };

async function makeCore() {
  const store = new MemoryWorldStore();
  const core = new WorldCoreImpl({
    store,
    heartbeatTimeoutMs: 1000,
    heartbeatIntervalMs: 100,
    apiKeyHash: await argon2.hash(API_KEY),
  });
  return { core, store };
}

const RANGE_B = { x0: 100, x1: 200, z0: 0, z1: 100 }; // adjacent, no overlap

async function register(core: WorldCoreImpl, regionId: string): Promise<void> {
  await core.registerRegion({
    regionId,
    chunkRange: regionId === "r2" ? RANGE_B : RANGE,
    endpoint: "ws://localhost:7777",
    capacity: 1000,
    apiKey: API_KEY,
    opId: `op-${regionId}-${Math.random().toString(36).slice(2)}`,
  });
}

type Run = {
  instance: string;
  dungeon: string;
  entrance: string;
  outcome: "cleared";
  startedAt: number;
  endedAt: number;
  members: number[];
  kills: { characterId: number; kind: string; count: number }[];
  deaths: { characterId: number; count: number }[];
  loot: { characterId: number; def: number }[];
};

type CoreSlice = {
  reportDungeonResults: (caller: string, input: { regionId: string; results: Run[] }) => Promise<{ ingested: string[] }>;
};
type StoreSlice = { listDungeonRuns: (regionId?: string) => Promise<Run[]> };

const runAbc: Run = {
  instance: "run-abc",
  dungeon: "grim-1",
  entrance: "barrow-gate",
  outcome: "cleared",
  startedAt: 1000,
  endedAt: 2000,
  members: [7],
  kills: [{ characterId: 7, kind: "goblin", count: 2 }],
  deaths: [],
  loot: [{ characterId: 7, def: 11 }],
};

const runDef: Run = {
  instance: "run-def",
  dungeon: "grim-1",
  entrance: "barrow-gate",
  outcome: "cleared",
  startedAt: 3000,
  endedAt: 4000,
  members: [7, 9],
  kills: [{ characterId: 9, kind: "skeleton", count: 1 }],
  deaths: [{ characterId: 7, count: 1 }],
  loot: [],
};

test("reportDungeonResults ingests runs once; a replay ingests but stores nothing twice", async () => {
  const { core, store } = await makeCore();
  await register(core, "r1");
  const c = core as unknown as CoreSlice;
  const s = store as unknown as StoreSlice;
  const first = await c.reportDungeonResults("r1", { regionId: "r1", results: [runAbc, runDef] });
  assert.deepEqual(first, { ingested: ["run-abc", "run-def"] });
  assert.equal((await s.listDungeonRuns("r1")).length, 2);
  const replay = await c.reportDungeonResults("r1", { regionId: "r1", results: [runAbc] });
  assert.deepEqual(replay, { ingested: ["run-abc"] });
  assert.equal((await s.listDungeonRuns("r1")).length, 2);
});

test("reportDungeonResults rejects a caller reporting for another region", async () => {
  const { core } = await makeCore();
  await register(core, "r1");
  await register(core, "r2");
  const c = core as unknown as CoreSlice;
  await assert.rejects(c.reportDungeonResults("r2", { regionId: "r1", results: [runAbc] }), (e) => {
    assert.ok(e instanceof WorldError && e.code === 403);
    return true;
  });
});

test("reportDungeonResults rejects an unknown region", async () => {
  const { core } = await makeCore();
  const c = core as unknown as CoreSlice;
  await assert.rejects(c.reportDungeonResults("ghost", { regionId: "ghost", results: [runAbc] }), (e) => {
    assert.ok(e instanceof WorldError && e.code === 404);
    return true;
  });
});
