/**
 * Save-sweep write bench: sequential putCharacterState vs the batched
 * putCharacterStates, through the real SurrealWorldStore on the
 * embedded engine (mem:// = SurrealMX). Run after `npm run build`:
 *   node bench-batch.mjs [records]
 * Sandbox numbers are a floor (2 vCPU shared box), not hardware truth.
 */
import { SurrealWorldStore } from "./dist/src/surreal-store.js";

const N = Number(process.argv[2] ?? 500);
const rec = (i, v) => ({
  characterId: i,
  state: { gold: 100 + i, inventory: ["sword", "shield"], skills: { mining: 3 }, pos: [i, 64, i] },
  version: v,
  epoch: 1,
  regionId: "r1",
  updatedAt: 1_793_236_200_000 + v,
});

const store = new SurrealWorldStore({ url: "mem://", namespace: "bench", database: "batch_" + Date.now() });
await store.connect();

async function time(label, fn) {
  const t0 = performance.now();
  await fn();
  const dt = performance.now() - t0;
  console.log(`${label}: ${N} recs in ${dt.toFixed(0)} ms = ${(N / (dt / 1000)).toFixed(0)} recs/s`);
}

await time("sequential putCharacterState (1 upsert each)", async () => {
  for (let i = 0; i < N; i++) await store.putCharacterState(rec(i, 1));
});
await time("batched putCharacterStates (1 call)          ", async () => {
  await store.putCharacterStates(Array.from({ length: N }, (_, i) => rec(i, 2)));
});
await time("sequential putCharacterState (repeat)        ", async () => {
  for (let i = 0; i < N; i++) await store.putCharacterState(rec(i, 3));
});
await time("batched putCharacterStates (repeat)          ", async () => {
  await store.putCharacterStates(Array.from({ length: N }, (_, i) => rec(i, 4)));
});
const spot = await store.getCharacterState(7);
console.log(`spot check char 7: version=${spot?.version} (expect 4)`);
await store.close();
process.exit(0);
