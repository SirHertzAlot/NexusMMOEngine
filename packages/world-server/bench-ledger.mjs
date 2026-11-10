/**
 * Store-level ledger benchmark (diagnostic, not a test).
 *
 * Drives SurrealWorldStore (embedded SurrealDB, mem://) the way the
 * region shipper + boot recall do:
 *   - appends in capped batches of 512 events (LEDGER_BATCH_MAX_EVENTS)
 *   - reads the contiguous head (the shipper polls it every save cycle)
 *   - reads the full stream back (boot recall, afterSeq = 0)
 * and reports events/s and per-call latencies at growing stream sizes.
 *
 * Usage: node bench-ledger.mjs [totalEvents]
 */
import { SurrealWorldStore } from "./dist/src/surreal-store.js";

const TOTAL = Number(process.argv[2] ?? 20000);
const BATCH = 512;
const RK = "bench:0:0:0:0";

const store = new SurrealWorldStore({ url: "mem://", namespace: "bench", database: "bench" });
await store.connect();

const ev = (seq) => ({
  seq,
  kind: "item",
  payload: { itemId: `item-${seq}`, op: "grant", gold: seq },
  tick: seq * 10,
  ts: 1_700_000_000_000 + seq,
});

const now = () => performance.now();

// Phase 1: append TOTAL events in shipper-sized batches.
let appended = 0;
let appendMs = 0;
const batchLat = [];
while (appended < TOTAL) {
  const batch = [];
  for (let i = 0; i < Math.min(BATCH, TOTAL - appended); i++) batch.push(ev(appended + i + 1));
  const t0 = now();
  const head = await store.appendLedgerEvents(RK, batch);
  const dt = now() - t0;
  appendMs += dt;
  batchLat.push(dt);
  if (head !== appended + batch.length) throw new Error(`head ${head} != ${appended + batch.length}`);
  appended += batch.length;
  if (appended % (BATCH * 10) === 0) {
    console.log(`  appended ${appended}/${TOTAL}  (${(appended / (appendMs / 1000)).toFixed(0)} ev/s so far)`);
  }
}
batchLat.sort((a, b) => a - b);
console.log(`APPEND ${TOTAL} events in batches of ${BATCH}: ${(TOTAL / (appendMs / 1000)).toFixed(0)} events/s, batch p50 ${batchLat[Math.floor(batchLat.length / 2)].toFixed(1)} ms, last batch ${batchLat[batchLat.length - 1].toFixed(1)} ms`);

// Phase 2: head reads at full size (shipper poll shape).
for (let i = 0; i < 3; i++) {
  const t0 = now();
  const head = await store.getLedgerHead(RK);
  console.log(`HEAD @${TOTAL}: ${head} in ${(now() - t0).toFixed(1)} ms`);
}

// Phase 3: full recall read.
{
  const t0 = now();
  const events = await store.getLedgerEvents(RK, 0);
  console.log(`RECALL getLedgerEvents(0) @${TOTAL}: ${events.length} events in ${(now() - t0).toFixed(1)} ms`);
}
// Phase 4: tail read (recall resume shape).
{
  const t0 = now();
  const events = await store.getLedgerEvents(RK, TOTAL - 100);
  console.log(`TAIL getLedgerEvents(${TOTAL - 100}) @${TOTAL}: ${events.length} events in ${(now() - t0).toFixed(1)} ms`);
}
// Phase 5: duplicate re-append (shipper retry shape) — one full batch again.
{
  const batch = [];
  for (let i = 0; i < BATCH; i++) batch.push(ev(i + 1));
  const t0 = now();
  const head = await store.appendLedgerEvents(RK, batch);
  console.log(`RE-APPEND duplicate batch of ${BATCH}: head ${head} in ${(now() - t0).toFixed(1)} ms`);
}

process.exit(0);
