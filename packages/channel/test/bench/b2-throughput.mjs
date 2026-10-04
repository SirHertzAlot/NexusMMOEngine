/**
 * B2: channel throughput. N concurrent channel clients (10, 50, 100) send
 * player.intent in a tight loop (one in flight each) for E5_B2_SECONDS
 * (default 30) against a core process whose handler answers at once.
 * Flags p99 > 10 ms at 100 clients.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ChannelClient } from "../../dist/src/index.js";
import { record, stats } from "./results.mjs";

const SECONDS = +(process.env.E5_B2_SECONDS ?? 30);
const echo = `
import { serveChannel } from ${JSON.stringify(new URL("../../dist/src/index.js", import.meta.url).href)};
const s = await serveChannel(0, async () => ({ accepted: true, tick: 0 }));
console.log(s.port);`;
const proc = spawn(process.execPath, ["--input-type=module", "-e", echo], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => createInterface({ input: proc.stdout }).once("line", (l) => r(+l)));

const rows = [];
for (const n of [10, 50, 100]) {
  const clients = await Promise.all(Array.from({ length: n }, async () => { const c = new ChannelClient({ port }); await c.connect(); return c; }));
  const lat = [];
  let done = 0;
  const end = Date.now() + SECONDS * 1000;
  await Promise.all(clients.map(async (c, ci) => {
    let i = 0;
    while (Date.now() < end) {
      const t0 = performance.now();
      await c.request("player.intent", { token: "t", intent: { mx: 1 } }, `${ci}-${i++}`);
      lat.push(performance.now() - t0);
      done++;
    }
  }));
  for (const c of clients) c.close();
  const s = stats(lat);
  rows.push({ clients: n, reqPerSec: Math.round(done / SECONDS), latencyMs: s });
}
proc.kill();
const at100 = rows.find((r) => r.clients === 100);
const flag = at100.latencyMs.p99 > 10;
record("B2", "Channel throughput", { seconds: SECONDS, rows, flagP99Over10msAt100: flag }, `
Concurrent channel clients, each with one \`player.intent\` in flight, for ${SECONDS} s against a core process that answers at once. Latency is request to answer, ms.

| Clients | req/s | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
${rows.map((r) => `| ${r.clients} | ${r.reqPerSec} | ${r.latencyMs.p50} | ${r.latencyMs.p95} | ${r.latencyMs.p99} | ${r.latencyMs.max} |`).join("\n")}

${flag ? "**FLAG:** p99 exceeds 10 ms at 100 clients." : "p99 stays under 10 ms at 100 clients."} Baseline only; no budget.
`);
process.exit(0);
