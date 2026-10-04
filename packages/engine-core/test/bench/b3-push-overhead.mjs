/**
 * B3: tick overhead of the channel pushes. The same seeded world of 1000
 * moving entities, 1000 ticks each way: pushes disabled (no channel) vs
 * enabled (the core channel serving one connected edge that reads every
 * push). Budget: pushes add < 0.5 ms mean per tick.
 */
import { ChannelClient } from "@mmo-engine/channel";
import { startCoreChannel } from "../../dist/src/index.js";
import { record, round, stats } from "../../../channel/test/bench/results.mjs";
import { benchGateway } from "./world.mjs";

const ENTITIES = 1000, TICKS = 1000, WARMUP = 100, STEP = 1000 / 30;

async function run(withPushes) {
  let now = 1_000_000;
  const gw = await benchGateway({ entities: ENTITIES, clock: () => now });
  gw.frame(now);
  let core = null, client = null, received = 0;
  if (withPushes) {
    core = await startCoreChannel(gw, 0);
    client = new ChannelClient({ port: core.server.port });
    client.onPush("tick.delta", () => received++);
    await client.connect();
    await new Promise((r) => setTimeout(r, 20));
  }
  const times = [];
  for (let i = 0; i < WARMUP + TICKS; i++) {
    now += STEP;
    const t0 = performance.now();
    gw.frame(now);
    const dt = performance.now() - t0;
    if (i >= WARMUP) times.push(dt);
    if (withPushes && i % 50 === 0) await new Promise((r) => setImmediate(r)); // let the socket drain, as the wall-clock loop would
  }
  await new Promise((r) => setTimeout(r, 200));
  client?.close(); await core?.close(); await gw.close();
  return { tickMs: stats(times), received };
}

const off = await run(false);
const on = await run(true);
const added = round(on.tickMs.mean - off.tickMs.mean);
const pass = added < 0.5;
record("B3", "Tick overhead of pushes", { entities: ENTITIES, ticks: TICKS, disabled: off.tickMs, enabled: on.tickMs, addedMeanMs: added, pushesReceived: on.received, budget: "< 0.5 ms mean", pass }, `
${ENTITIES} moving entities, ${TICKS} measured ticks after ${WARMUP} warm-up, same seed, ticks driven back to back. Tick time, ms:

| Pushes | mean | p50 | p99 | max |
|---|---|---|---|---|
| disabled | ${off.tickMs.mean} | ${off.tickMs.p50} | ${off.tickMs.p99} | ${off.tickMs.max} |
| enabled (1 edge connected) | ${on.tickMs.mean} | ${on.tickMs.p50} | ${on.tickMs.p99} | ${on.tickMs.max} |

Added mean per tick: **${added} ms** (budget < 0.5 ms): **${pass ? "PASS" : "BREACH"}**. The edge received ${on.received} \`tick.delta\` pushes.
`);
process.exit(0);
