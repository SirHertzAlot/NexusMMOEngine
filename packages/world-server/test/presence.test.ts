/**
 * Cross-region presence (roadmap S2, slice 1): regions report the
 * character names playing on them; the world maps names to regions so a
 * region can show friends playing elsewhere as online.
 *
 * Seam: WorldCore.setPresence/queryPresence over the WorldStore boundary
 * (MemoryWorldStore here). Transport and the gateway merge follow.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as argon2 from "argon2";
import { WorldCoreImpl } from "../src/core.js";
import { MemoryWorldStore } from "../src/fake-store.js";
import { WorldError } from "../src/types.js";

const API_KEY = "test-bootstrap-key-123";
const RANGE_A = { x0: 0, x1: 100, z0: 0, z1: 100 };
const RANGE_B = { x0: 100, x1: 200, z0: 0, z1: 100 };

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

async function register(core: WorldCoreImpl, regionId: string): Promise<void> {
  await core.registerRegion({
    regionId,
    chunkRange: regionId === "r2" ? RANGE_B : RANGE_A,
    endpoint: "ws://localhost:7777",
    capacity: 1000,
    apiKey: API_KEY,
    opId: `op-${regionId}-${Math.random().toString(36).slice(2)}`,
  });
}

type CoreSlice = {
  setPresence: (caller: string, input: { regionId: string; names: string[] }) => Promise<void>;
  queryPresence: (caller: string, input: { regionId: string; names: string[] }) => Promise<{ online: Record<string, string | null> }>;
};

test("presence maps names to regions; a re-report replaces; logout clears", async () => {
  const { core } = await makeCore();
  await register(core, "r1");
  await register(core, "r2");
  const c = core as unknown as CoreSlice;
  await c.setPresence("r1", { regionId: "r1", names: ["Aria", "Bram"] });
  await c.setPresence("r2", { regionId: "r2", names: ["Cass"] });
  assert.deepEqual(await c.queryPresence("r1", { regionId: "r1", names: ["Aria", "Bram", "Cass", "Nobody"] }), {
    online: { Aria: "r1", Bram: "r1", Cass: "r2", Nobody: null },
  });
  await c.setPresence("r1", { regionId: "r1", names: ["Bram"] });
  assert.deepEqual((await c.queryPresence("r2", { regionId: "r2", names: ["Aria", "Bram"] })).online, {
    Aria: null,
    Bram: "r1",
  });
});

test("presence rejects another region's report and unknown regions", async () => {
  const { core } = await makeCore();
  await register(core, "r1");
  await register(core, "r2");
  const c = core as unknown as CoreSlice;
  await assert.rejects(c.setPresence("r2", { regionId: "r1", names: ["Aria"] }), (e) => {
    assert.ok(e instanceof WorldError && e.code === 403);
    return true;
  });
  await assert.rejects(c.queryPresence("ghost", { regionId: "ghost", names: ["Aria"] }), (e) => {
    assert.ok(e instanceof WorldError && e.code === 404);
    return true;
  });
});
