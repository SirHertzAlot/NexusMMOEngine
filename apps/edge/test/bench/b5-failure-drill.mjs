/**
 * B5: failure drill timings, wall clock. A real core process and the edge,
 * one player in the world sending player.intent every 50 ms throughout.
 *
 *  A. kill -9 the core: time to the edge marking it down, time from down
 *     to the first core.unavailable served, and (after a restart on the
 *     same port) time to resync complete.
 *  B. SIGSTOP the core (hung, socket still open): time to down through
 *     the heartbeat (heartbeatMs × maxMissed = 15 s at the defaults), then
 *     SIGCONT and time to resync complete.
 *
 * Blackout assertion: every core-bound packet sent during the drill gets
 * an answer (its own type or core.unavailable); zero silent hangs.
 */
import { record, round } from "../../../../packages/channel/test/bench/results.mjs";
import { edgeClient, hr, intent, joinPlayer, sleep, startCore, startEdge } from "./harness.mjs";

let core = await startCore(0, 1000, 1);
const channelPort = core.channelPort;
const edge = await startEdge(channelPort);
const client = await edgeClient(edge.wsPort);
let { token } = await joinPlayer(client, core.gatewayPort, "bench-0");

const answers = [];
let sent = 0, running = true;
const sender = (async () => {
  let i = 0;
  while (running) {
    sent++;
    client.request("player.intent", { token, intent: intent(i++) }).then((r) => answers.push({ at: hr(), type: r.type }));
    await sleep(50);
  }
})();
const firstAfter = (t, type) => answers.find((a) => a.at >= t && a.type === type)?.at ?? NaN;
const eventAfter = (t, prefix) => edge.events.find((e) => e.at >= t && e.line.startsWith(prefix))?.at ?? NaN;
async function waitFor(fn, ms) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await sleep(5); } }

await sleep(1000);
// A. kill -9
const tKill = hr();
core.proc.kill("SIGKILL");
await waitFor(() => edge.lifecycle.coreStatus === "down", 30000);
const tDownA = eventAfter(tKill, "core channel down");
await waitFor(() => !Number.isNaN(firstAfter(tDownA, "core.unavailable")), 5000);
const tUnavailA = firstAfter(tDownA, "core.unavailable");
await sleep(2000);
const tRestart = hr();
core = await startCore(channelPort, 1000, 1);
await waitFor(() => edge.lifecycle.coreStatus === "up", 60000);
const tResyncA = eventAfter(tRestart, "core resync complete");
({ token } = await joinPlayer(client, core.gatewayPort, "bench-0")); // the bench core keeps sessions in memory

// B. hung core
await sleep(1000);
const tStop = hr();
core.proc.kill("SIGSTOP");
await waitFor(() => edge.lifecycle.coreStatus === "down", 60000);
const tDownB = eventAfter(tStop, "core channel down");
const tUnavailB = firstAfter(tStop, "core.unavailable");
const tCont = hr();
core.proc.kill("SIGCONT");
await waitFor(() => edge.lifecycle.coreStatus === "up", 60000);
const tResyncB = eventAfter(tCont, "core resync complete");

running = false; await sender;
await sleep(6000); // longer than the 5 s request timeout
const hung = client.pendingCount();
const unavailable = answers.filter((a) => a.type === "core.unavailable").length;
const s = (x) => round(x / 1000, 3);
const summary = {
  killed: { detectS: s(tDownA - tKill), downToFirstUnavailableMs: round(tUnavailA - tDownA, 1), restartToResyncS: s(tResyncA - tRestart) },
  hung: { detectS: s(tDownB - tStop), stopToFirstUnavailableS: s(tUnavailB - tStop), contToResyncS: s(tResyncB - tCont) },
  blackout: { sent, answered: answers.length, coreUnavailable: unavailable, silentHangs: hung },
  pass: hung === 0,
};
record("B5", "Failure drill timings", summary, `
A core process with 1000 entities, the edge at default heartbeat (5000 ms × 3), one player sending \`player.intent\` every 50 ms throughout.

| Drill | Detect (core marked down) | First \`core.unavailable\` | Back to up (resync complete) |
|---|---|---|---|
| \`kill -9\` the core | ${summary.killed.detectS} s | ${summary.killed.downToFirstUnavailableMs} ms after down | ${summary.killed.restartToResyncS} s after restart (process boot + first reconnect step) |
| hung core (\`SIGSTOP\`) | ${summary.hung.detectS} s (heartbeat) | ${summary.hung.stopToFirstUnavailableS} s after the stop (request timeout) | ${summary.hung.contToResyncS} s after \`SIGCONT\` |

Blackout: ${sent} core-bound packets sent, ${answers.length} answered (${unavailable} with \`core.unavailable\`), **${hung} silent hangs**. ${hung === 0 ? "PASS." : "FAIL."}

A killed core closes its socket, so the edge knows at once. A hung core is only caught by the heartbeat; until then core-bound packets wait out the 5 s request timeout before answering \`core.unavailable\`. Whether 15 s detection is acceptable is Joey's call (a config change: \`heartbeatMs\`, \`maxMissed\`).
`);
client.close(); edge.close(); core.proc.kill("SIGKILL");
process.exit(0);
