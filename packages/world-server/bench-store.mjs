/**
 * Store-level write-path benchmark (diagnostic, not a test).
 *
 * Drives the SurrealWorldStore put/issue methods the way the world
 * core does on its save and session cycles — mostly REPEAT writes to
 * the same keys — and reports ops/s and mean latency per method.
 *
 * Usage: node bench-store.mjs [repeats]
 */
import { SurrealWorldStore } from "./dist/src/surreal-store.js";

const N = Number(process.argv[2] ?? 500);
const store = new SurrealWorldStore({ url: "mem://", namespace: "bench2", database: "bench2" });
await store.connect();

async function bench(name, fn) {
  const t0 = performance.now();
  for (let i = 0; i < N; i++) await fn(i);
  const ms = performance.now() - t0;
  console.log(`${name}: ${(N / (ms / 1000)).toFixed(0)} ops/s, mean ${(ms / N).toFixed(2)} ms/op`);
}

const state = (id, v) => ({
  characterId: id,
  state: { hp: 100, gold: v, items: [{ id: "sword" }, { id: "shield" }], pos: { x: 1, y: 2, z: 3 } },
  version: v,
  epoch: 1,
  regionId: "r1",
  updatedAt: 1_700_000_000_000 + v,
});

// First writes: N distinct characters (registration-shaped).
await bench(`putCharacterState x${N} (distinct)`, (i) => store.putCharacterState(state(i + 1, 1)));
// Repeat writes: the save-cycle shape — same characters, new versions.
await bench(`putCharacterState x${N} (repeat)`, (i) => store.putCharacterState(state(i + 1, 2)));
await bench(`putShardSnapshot x${N} (repeat)`, (i) =>
  store.putShardSnapshot({ rangeKey: "0:0:0:0", regionId: "r1", tick: i, epoch: 1, digest: "d", payload: { n: i }, storedAt: i }),
);
await bench(`putCharacterLock x${N} (repeat)`, (i) =>
  store.putCharacterLock({ characterId: 42, regionId: "r1", epoch: 1, expiresAt: 1_700_000_000_000 + i }),
);
await bench(`putSocialRecord x${N} (repeat)`, (i) =>
  store.putSocialRecord({ kind: "guild", key: "g1", doc: { name: "G", members: [1, 2, 3] }, version: i, regionId: "r1", updatedAt: i }),
);
await bench(`issueCharacterLockEpoch x${N}`, () => store.issueCharacterLockEpoch(42));
await bench(`upsertHostReport x${N} (repeat)`, (i) =>
  store.upsertHostReport({ hostId: "h1", cpuCores: 8, ramTotalBytes: 1e10, ramFreeBytes: 5e9, shardLoad: 0.5, reportedAt: i }),
);
await bench(`storeOpResult+getOpResult x${N}`, async (i) => {
  await store.storeOpResult(`op-${i}`, { ackedSeq: i });
  await store.getOpResult(`op-${i}`);
});

process.exit(0);
