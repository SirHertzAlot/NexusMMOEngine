/**
 * Phase 5 benchmark gate, Part A: sector-topic publish vs the old
 * per-socket send loop. Same N subscribers, same bytes — the only
 * difference is the fan-out mechanism.
 *
 * Run: node packages/engine-core/test/bench/b5-pubsub.mjs
 * (from the repo root, after building @mmo-engine/engine-core).
 *
 * What it measures is the cost the TICK pays: enqueueing one tick's
 * delta for N subscribers. Iterations run back-to-back with no yields,
 * so delivery/drain (loopback + 1000 client message handlers) cannot
 * pollute the number — sends just enqueue into socket buffers (60
 * iterations x 1000 clients x 1200 B = 72 KB per socket, far under
 * uWS's 64 MB backpressure limit), and the run drains at the end.
 *
 * For each transport (uWS when it loads, else ws only) and each
 * layout (1 sector topic, 8 sector topics), N=1000 real clients:
 *   before: one socket.send() per subscriber (the Phase 1-4 path);
 *   after:  one transport.publish() per occupied topic (Phase 5).
 * uWS publishes natively in C++ (one JS->native call fans out to all
 * subscribers); the `ws` fallback emulates it with a subscriber loop,
 * so its publish ≈ its send loop (parity, not a win) — the win lives
 * on uWS, the production transport.
 */

import { WebSocket } from "ws";
import { createTransport, loadUws } from "../../dist/src/net/transport.js";

const N = 1000;
const DELTA = new Uint8Array(1200).map((_, i) => i & 0xff);
const ITERS = 60;
const WARMUP = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectMany(port, n) {
  const clients = [];
  for (let i = 0; i < n; i += 50) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(50, n - i) }, () => new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on("message", () => {});
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      })),
    );
    clients.push(...batch);
  }
  return clients;
}

async function timeIt(fn, iters) {
  for (let i = 0; i < WARMUP; i++) fn();
  await sleep(200); // drain warm-up enqueues
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = (performance.now() - t0) / iters;
  await sleep(500); // drain before the next measurement
  return ms;
}

async function runOne(kind, sectors) {
  const transport = createTransport(kind);
  const serverSockets = [];
  const port = await transport.listen(0, {
    connection: (s) => serverSockets.push(s),
    http: null,
  });
  const clients = await connectMany(port, N);
  while (serverSockets.length < N) await sleep(10);

  // Subscribe round-robin across `sectors` topics.
  const topics = Array.from({ length: sectors }, (_, i) => `sector:${i},0`);
  serverSockets.forEach((s, i) => s.subscribe(topics[i % sectors]));

  const sendLoop = () => { for (const s of serverSockets) s.send(DELTA); };
  const publish = () => { for (const topic of topics) transport.publish(topic, DELTA); };

  const before = await timeIt(sendLoop, ITERS);
  const after = await timeIt(publish, ITERS);

  for (const c of clients) c.close();
  await transport.close();
  await sleep(100);
  return { kind, sectors, before, after };
}

const kinds = loadUws() ? ["uws", "ws"] : ["ws"];
console.log(`Phase 5 fan-out: N=${N} subscribers, ${ITERS} iterations, 1200-byte delta`);
for (const kind of kinds) {
  for (const sectors of [1, 8]) {
    const { before, after } = await runOne(kind, sectors);
    const ratio = before / after;
    const verdict = ratio >= 1 ? `${ratio.toFixed(2)}x faster` : `${(1 / ratio).toFixed(2)}x slower`;
    console.log(
      `${kind.padEnd(3)} ${String(sectors).padStart(2)} topic(s): ` +
      `send-loop ${before.toFixed(3)} ms/tick -> publish ${after.toFixed(3)} ms/tick (${verdict})`,
    );
  }
}
