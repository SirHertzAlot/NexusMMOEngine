/**
 * B4: delta bandwidth at scale. 1k, 5k and 10k moving entities, 300 ticks
 * each: the size of every tick.delta frame the channel would carry, the
 * bandwidth at 30 Hz, and the time to encode each push (base64 + JSON +
 * frame). Budget: encode p99 < 5 ms. Snapshots are reported as info.
 */
import { encodeFrame } from "@mmo-engine/channel";
import { record, round, stats } from "../../../channel/test/bench/results.mjs";
import { benchGateway } from "./world.mjs";

const TICKS = 300, STEP = 1000 / 30;
const rows = [];
for (const entities of [1000, 5000, 10000]) {
  let now = 1_000_000;
  const gw = await benchGateway({ entities, clock: () => now });
  gw.frame(now);
  const enc = [], bytes = [], snapBytes = [], snapEnc = [];
  gw.addTickListener((t) => {
    const t0 = performance.now();
    const frame = encodeFrame({ type: "tick.delta", id: "push-0", payload: { tick: t.tick, delta: Buffer.from(t.delta).toString("base64") } });
    enc.push(performance.now() - t0);
    bytes.push(frame.length);
    if (t.tick % 300 === 0) {
      const s0 = performance.now();
      const sf = encodeFrame({ type: "snapshot", id: "push-1", payload: { tick: t.tick, snapshot: Buffer.from(t.fullState()).toString("base64") } });
      snapEnc.push(performance.now() - s0); snapBytes.push(sf.length);
    }
  });
  for (let i = 0; i < TICKS; i++) { now += STEP; gw.frame(now); }
  await gw.close();
  const meanBytes = bytes.reduce((a, b) => a + b, 0) / bytes.length;
  rows.push({ entities, meanFrameBytes: Math.round(meanBytes), kbPerSecAt30Hz: round((meanBytes * 30) / 1024, 1), encodeMs: stats(enc), snapshotBytes: snapBytes[0] ?? null, snapshotEncodeMs: snapEnc[0] != null ? round(snapEnc[0]) : null });
}
const worst = Math.max(...rows.map((r) => r.encodeMs.p99));
const pass = worst < 5;
record("B4", "Delta bandwidth at scale", { ticks: TICKS, rows, budget: "encode p99 < 5 ms", pass }, `
Every entity moves every tick, so every delta carries all of them (the worst case). ${TICKS} ticks per row. Encode = FlatBuffers bytes to base64, JSON, and the length-prefixed frame.

| Entities | delta frame (mean) | at 30 Hz | encode p50 ms | encode p99 ms | snapshot frame | snapshot encode ms |
|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.entities} | ${(r.meanFrameBytes / 1024).toFixed(1)} KiB | ${r.kbPerSecAt30Hz} KiB/s | ${r.encodeMs.p50} | ${r.encodeMs.p99} | ${r.snapshotBytes ? (r.snapshotBytes / 1024).toFixed(1) + " KiB" : "n/a"} | ${r.snapshotEncodeMs ?? "n/a"} |`).join("\n")}

Encode p99 budget < 5 ms: **${pass ? "PASS" : "BREACH"}** (worst ${worst} ms).
`);
process.exit(0);
