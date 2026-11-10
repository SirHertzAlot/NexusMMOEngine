/**
 * External-server probe: same store code, live SurrealDB server over
 * WebSocket. Sequential puts + concurrency curve + ledger append.
 */
import { SurrealWorldStore } from "./dist/src/surreal-store.js";

const store = new SurrealWorldStore({
  url: "ws://127.0.0.1:8000",
  namespace: "benchx",
  database: "benchx",
  username: "root",
  password: "root",
});
await store.connect();
console.log("connected to external server");

const state = (id, v) => ({
  characterId: id,
  state: { hp: 100, gold: v, items: [{ id: "sword" }], pos: { x: 1, y: 2, z: 3 } },
  version: v,
  epoch: 1,
  regionId: "r1",
  updatedAt: 1_700_000_000_000 + v,
});

// sequential, 500 repeat puts (matches bench-store methodology)
{
  const t0 = performance.now();
  for (let i = 0; i < 500; i++) await store.putCharacterState(state(42, 2));
  const ms = performance.now() - t0;
  console.log(`seq putCharacterState: ${(500 / (ms / 1000)).toFixed(0)} ops/s (${(ms / 500).toFixed(2)} ms/op)`);
}

// concurrency curve, 2000 total puts on distinct characters
for (const W of [1, 8, 32]) {
  const TOTAL = 2000;
  let next = 0;
  const t0 = performance.now();
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= TOTAL) return;
      await store.putCharacterState(state(200000 + W * 10000 + i, 1));
    }
  };
  await Promise.all(Array.from({ length: W }, worker));
  const ms = performance.now() - t0;
  console.log(`conc W=${W}: ${(TOTAL / (ms / 1000)).toFixed(0)} ops/s`);
}
process.exit(0);
