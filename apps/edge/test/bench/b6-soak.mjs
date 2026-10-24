/**
 * B6: soak. A core process and the edge for E5_B6_SECONDS (default 600),
 * 20 players in the world each sending player.intent at 5 Hz, the tick
 * stream flowing. Asserts: no unhandled rejections (edge or core), no
 * dropped tick.events pushes (tick numbers strictly sequential at the edge),
 * RSS growth < 100 MB over the run (edge and core each). The players run in
 * their own process (players-proc.mjs) so the edge's RSS is the edge's alone.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { record, round } from "../../../../packages/channel/test/bench/results.mjs";
import { sleep, startCore, startEdge } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SECONDS = +(process.env.E5_B6_SECONDS ?? 600);
const PLAYERS = 20;
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(String(e)));
const rssOf = (pid) => +(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) / 1024; // MiB

const core = await startCore(0, 1000, PLAYERS);
const edge = await startEdge(core.channelPort);
const playersProc = spawn(process.execPath, [path.join(HERE, "players-proc.mjs"), String(edge.wsPort), String(core.gatewayPort), String(PLAYERS), String(SECONDS)], { stdio: ["ignore", "pipe", "inherit"] });
const lines = createInterface({ input: playersProc.stdout });
const nextLine = () => new Promise((r) => lines.once("line", (l) => r(JSON.parse(l))));
await nextLine(); // joined
await sleep(2000);
const t0 = Date.now();
const rss0 = { edge: process.memoryUsage().rss / 2 ** 20, core: rssOf(core.proc.pid) };
const ticks0 = edge.ticks.count;
const samples = [];
const sampler = setInterval(() => samples.push({ t: Math.round((Date.now() - t0) / 1000), edge: round(process.memoryUsage().rss / 2 ** 20, 1), core: round(rssOf(core.proc.pid), 1) }), 10000);
const { sent, accepted, refused, other } = await nextLine();
clearInterval(sampler);
const rss1 = { edge: process.memoryUsage().rss / 2 ** 20, core: rssOf(core.proc.pid) };
const growth = { edge: round(rss1.edge - rss0.edge, 1), core: round(rss1.core - rss0.core, 1) };
const ticks = edge.ticks.count - ticks0;
const allUnhandled = [...unhandled, ...core.unhandled];
const pass = allUnhandled.length === 0 && edge.ticks.gaps === 0 && growth.edge < 100 && growth.core < 100;
record("B6", "Soak", { seconds: SECONDS, players: PLAYERS, intentsSent: sent, accepted, refused, otherAnswers: other, ticksReceived: ticks, tickGaps: edge.ticks.gaps, rssGrowthMiB: growth, rssMiB: { start: rss0, end: rss1 }, unhandledRejections: allUnhandled.length, samples, pass }, `
${SECONDS} s, ${PLAYERS} players in the world each sending \`player.intent\` at 5 Hz through the edge, a core process with 1000 moving entities.

| Check | Result |
|---|---|
| Unhandled rejections (edge + core) | ${allUnhandled.length} |
| \`tick.events\` pushes received / gaps in tick numbers | ${ticks} / ${edge.ticks.gaps} |
| Intents sent / accepted / refused / other answers | ${sent} / ${accepted} / ${refused} / ${other} |
| RSS growth, edge | ${growth.edge} MiB (${round(rss0.edge, 1)} → ${round(rss1.edge, 1)}) |
| RSS growth, core | ${growth.core} MiB (${round(rss0.core, 1)} → ${round(rss1.core, 1)}) |

**${pass ? "PASS" : "FAIL"}** (no unhandled rejections, no dropped deltas, RSS growth < 100 MB each).
`);
edge.close(); core.proc.kill("SIGTERM");
process.exit(0);
