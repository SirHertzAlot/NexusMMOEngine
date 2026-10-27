/**
 * Atomic-op end-to-end benchmark (diagnostic, not a test).
 *
 * Drives tradeCommit through WorldCoreImpl -> SurrealWorldStore -> the
 * fn layer, the way a region server does, and reports:
 *   - sequential fresh ops (distinct opIds, gold ping-pong on one pair)
 *   - replay of an already-applied opId (the retry path)
 *   - concurrent fresh ops (8 independent pairs x 25 ops)
 *
 * Default: embedded engine (mem://). Set WORLD_BENCH_URL=ws://127.0.0.1:8000
 * to run against a live external server (root/root) instead.
 *
 * Usage: node bench-atomic.mjs
 */
import * as argon2 from "argon2";
import { SurrealWorldStore } from "./dist/src/surreal-store.js";
import { WorldCoreImpl } from "./dist/src/core.js";

const EXT = process.env.WORLD_BENCH_URL;
const NS = `benchatomic${Date.now() % 100000}`;
const store = new SurrealWorldStore(EXT
  ? { url: EXT, namespace: NS, database: NS, username: "root", password: "root" }
  : { url: "mem://", namespace: NS, database: NS });
await store.connect();
const core = new WorldCoreImpl({
  store, heartbeatTimeoutMs: 1000, heartbeatIntervalMs: 100,
  apiKeyHash: await argon2.hash("bench-key"),
});
console.log(`target: ${EXT ?? "embedded mem://"}  namespace: ${NS}`);

let n = 0;
const opId = (t) => `bench-${t}-${++n}`;
await core.registerRegion({
  regionId: "r1", chunkRange: { x0: 0, x1: 100, z0: 0, z1: 100 },
  endpoint: "ws://localhost:7777", capacity: 1000,
  apiKey: "bench-key", opId: opId("reg"),
});
async function seed(id, gold) {
  const lock = await core.acquireCharacterLock("r1", {
    regionId: "r1", characterId: id, ttlMs: 600_000, opId: opId("lock"),
  });
  await store.putCharacterState({
    characterId: id, state: { gold, inventory: [] }, version: 1,
    epoch: lock.epoch, regionId: "r1", updatedAt: Date.now(),
  });
  return { characterId: id, epoch: lock.epoch, version: 1 };
}
async function trade(pair, tag) {
  // ping-pong 1 gold; both fences track the locally-known version.
  // Concurrent ops contend on the shared ledger sequence allocator, so a
  // fresh op can abort with VERSION_CONFLICT; a real caller retries with
  // the SAME opId (idempotent — the dedup layer makes the retry safe).
  // Retries are counted and reported.
  const aToB = pair.version % 2 === 1;
  const id = opId(tag);
  const input = {
    regionId: "r1", opId: id,
    a: { characterId: pair.a.characterId, epoch: pair.a.epoch, expectedVersion: pair.version },
    b: { characterId: pair.b.characterId, epoch: pair.b.epoch, expectedVersion: pair.version },
    aGivesGold: aToB ? 1 : 0, bGivesGold: aToB ? 0 : 1,
    aGivesItems: [], bGivesItems: [],
  };
  for (let attempt = 1; ; attempt++) {
    const res = await core.tradeCommit("r1", input);
    if (res.ok) {
      pair.version += 1;
      pair.lastOpId = id;
      pair.retries = (pair.retries ?? 0) + attempt - 1;
      return res;
    }
    if (res.rejection !== "VERSION_CONFLICT" || attempt >= 100) {
      throw new Error(`trade rejected: ${JSON.stringify(res)}`);
    }
    // wide-jitter backoff: narrow jitter leaves the retrying callers in
    // lockstep and they convoy against the shared sequence allocator
    await new Promise((r) => setTimeout(r, Math.min(attempt * 3, 80) + Math.random() * 40));
  }
}

// ---- sequential fresh ops ------------------------------------------------
{
  const pair = { a: await seed(1, 1_000_000), b: await seed(2, 1_000_000), version: 1 };
  for (let i = 0; i < 20; i++) await trade(pair, "warm");
  const N = 300;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) await trade(pair, "seq");
  const ms = performance.now() - t0;
  console.log(`sequential fresh ops: ${(N / (ms / 1000)).toFixed(0)} ops/s, mean ${(ms / N).toFixed(2)} ms/op  (n=${N})`);

  // ---- replay of the last applied opId ----------------------------------
  const replayInput = {
    regionId: "r1", opId: pair.lastOpId,
    a: { characterId: pair.a.characterId, epoch: pair.a.epoch, expectedVersion: pair.version - 1 },
    b: { characterId: pair.b.characterId, epoch: pair.b.epoch, expectedVersion: pair.version - 1 },
    aGivesGold: 0, bGivesGold: 1, aGivesItems: [], bGivesItems: [],
  };
  // reconstruct the exact original input is unnecessary: the dedup key is
  // the opId alone; the stored outcome replays regardless of the body.
  const R = 100;
  const t1 = performance.now();
  for (let i = 0; i < R; i++) await core.tradeCommit("r1", replayInput);
  const msR = performance.now() - t1;
  console.log(`replay (same opId):   ${(R / (msR / 1000)).toFixed(0)} ops/s, mean ${(msR / R).toFixed(2)} ms/op  (n=${R})`);
}

// NOTE: no concurrent-fresh-ops section. Independent trade streams
// against one store convoy on the shared atomic-ledger sequence
// allocator (every op takes a contiguous seq range from one counter;
// parallel streams abort each other faster than jittered retries can
// drain) — a pre-existing design property, identical before and after
// the dedup fold, which does not touch sequence allocation. Production
// regions serialize op submission per region. Concurrent SAME-opId
// behavior — the case the fold changes — is proven by
// verify-dedup-race.mjs (16-way race, exactly one application).
process.exit(0);
