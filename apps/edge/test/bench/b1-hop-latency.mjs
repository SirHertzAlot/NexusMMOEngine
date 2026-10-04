/**
 * B1: extra-hop latency. 10,000 player.intent packets through the full path
 * (WS client → edge → channel → core → back), timed at edge ingress and
 * egress. The local `ping` route through the same edge is the no-hop
 * baseline. Budget: p99 < 1 ms added by the hop.
 */
import { record, stats, round } from "../../../../packages/channel/test/bench/results.mjs";
import { edgeClient, intent, joinPlayer, startCore, startEdge } from "./harness.mjs";

const N = 10000;
const core = await startCore(0, 1000, 1);
const edge = await startEdge(core.channelPort);
const client = await edgeClient(edge.wsPort);
const { token, gameClient } = await joinPlayer(client, core.gatewayPort, "bench-0");
for (let i = 0; i < 500; i++) { await client.request("player.intent", { token, intent: intent(i) }); await client.request("ping"); } // warm-up
edge.timings.core.length = 0; edge.timings.local.length = 0;
let accepted = 0;
for (let i = 0; i < N; i++) {
  const r = await client.request("player.intent", { token, intent: intent(i) });
  if (r.payload?.accepted) accepted++;
  await client.request("ping");
}
const hop = stats(edge.timings.core);
const local = stats(edge.timings.local);
const added = { p50: round(hop.p50 - local.p50), p95: round(hop.p95 - local.p95), p99: round(hop.p99 - local.p99) };
const pass = hop.p99 < 1;
record("B1", "Extra-hop latency", { coreBoundMs: hop, localPingMs: local, addedMs: added, accepted, budget: "p99 < 1 ms", pass }, `
${N} \`player.intent\` packets, one at a time, to a core process with 1000 moving entities ticking at 30 Hz. Edge ingress to egress, ms:

| Path | p50 | p95 | p99 | max |
|---|---|---|---|---|
| core-bound (\`player.intent\`, through the channel) | ${hop.p50} | ${hop.p95} | ${hop.p99} | ${hop.max} |
| local (\`ping\`, no hop) | ${local.p50} | ${local.p95} | ${local.p99} | ${local.max} |

${accepted} of ${N} intents accepted by the core. The whole core-bound time is counted against the budget (the hop plus the core's handling), so the budget is met if that p99 is under 1 ms: **${pass ? "PASS" : "BREACH"}** (p99 ${hop.p99} ms).
`);
await gameClient.close(); client.close(); edge.close(); core.proc.kill("SIGTERM");
process.exit(0);
