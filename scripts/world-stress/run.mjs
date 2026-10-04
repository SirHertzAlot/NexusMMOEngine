/**
 * World-server stress harness (WORLD-SERVER-SPEC §11, slice D).
 *
 *   npm run stress:world [-- --window 30 --sweep 1,2,4,6,8 --entities 500 --players 40]
 *
 * For each N: one world server process (in-memory store, so the database
 * stays out of the measurement) and N region processes in a row, each a
 * real Gateway ticking `entities` moving entities at 30 Hz, with `players`
 * wandering across the borders. Region processes hand players over with
 * the MigrationCoordinator; this script plays each player's client, taking
 * the redirect from the source region to the target region.
 *
 * Measured per N over the window: webrpc p50/p99 per op, hand-off success
 * and duration (redirect to the target's commit), region tick jitter
 * (event-loop delay p99, i.e. how late a tick can start) and tick time,
 * world CPU and memory. The sweep stops at the first N that breaks a
 * spec stop condition: hand-off p99 > 500 ms, tick jitter > 8 ms or a
 * tick p99 past one 30 Hz frame (33.3 ms) on any region, or world CPU >
 * 80%. The result is the last N that held.
 *
 * Needs built dists: npm run build --workspace=@mmo-engine/engine-core
 */
import { fork, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i < 0 ? def : process.argv[i + 1]; };
const WINDOW_S = Number(arg("window", 30));
const WARMUP_S = Number(arg("warmup", 8));
const SWEEP = arg("sweep", "1,2,3,4,6,8,12,16").split(",").map(Number);
const ENTITIES = Number(arg("entities", 500));
const PLAYERS = Number(arg("players", 40));
const OUT = arg("out", path.join(os.tmpdir(), "world-stress.json"));
const KEY = "stress-api-key-123456";
// tickP99Ms: a region tick past one 30 Hz frame (33.3 ms) means the region
// can no longer hold its rate: the box is out of CPU for regions.
const LIMITS = { handoffP99Ms: 500, tickJitterMs: 8, tickP99Ms: 33.3, worldCpuPct: 80 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const TICKS = 100; // USER_HZ: /proc CPU times are in 1/100 s on Linux
function procStat(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
  const cpu = (Number(stat[11]) + Number(stat[12])) / TICKS; // utime + stime, seconds
  const rss = Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))[1]) / 1024;
  return { cpu, rss };
}

async function startWorld(port) {
  const proc = spawn(process.execPath, ["packages/world-server/dist/src/server.js"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, WORLD_PORT: String(port), WORLD_DB_URL: "mem:", WORLD_API_KEY: KEY,
      WORLD_HEARTBEAT_INTERVAL_MS: "1000", WORLD_HEARTBEAT_TIMEOUT_MS: "5000", WORLD_MIGRATION_TIMEOUT_MS: "5000" },
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => { if (String(d).includes("listening")) resolve(); });
    proc.once("exit", (c) => reject(new Error("world exited " + c)));
  });
  return proc;
}

async function runN(n) {
  const port = 7800 + n;
  const world = await startWorld(port);
  const regions = [];
  const byEndpoint = new Map();
  const redirectAt = new Map();
  const handoffs = [];
  let redirects = 0, accepted = 0, refused = 0;
  for (let i = 0; i < n; i++) {
    const regionId = `r${i}`;
    const proc = fork(path.join(ROOT, "scripts/world-stress/region-proc.mjs"), [JSON.stringify({
      regionId, index: i, regions: n, worldUrl: `http://127.0.0.1:${port}`, apiKey: KEY,
      entities: ENTITIES, players: PLAYERS, chunkSize: 16, chunksPerRegion: 8, speed: 7,
    })], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    byEndpoint.set(`ws://${regionId}.stress`, proc);
    regions.push(proc);
  }
  let measuring = false;
  const reports = [];
  for (const proc of regions) {
    proc.on("message", (m) => {
      if (m.type === "redirect") {
        // The player's client reconnects to the target region.
        if (measuring) redirects++;
        // Only hand-offs that began inside the window count, so the
        // success rate never passes 1.
        redirectAt.set(m.migrationId, { t0: performance.now(), measured: measuring });
        byEndpoint.get(m.endpoint)?.send({ type: "arrive", migrationId: m.migrationId });
      } else if (m.type === "accepted") {
        const r = redirectAt.get(m.migrationId);
        redirectAt.delete(m.migrationId);
        if (!measuring || !r?.measured) return;
        if (m.ok) { accepted++; handoffs.push(performance.now() - r.t0); } else refused++;
      } else if (m.type === "report") reports.push(m);
    });
  }
  const ready = await Promise.all(regions.map((p) => new Promise((r) => {
    p.on("message", (m) => m.type === "ready" && r(m));
    p.once("exit", (code) => r({ registered: false, error: `region exited ${code}` }));
  })));
  const unregistered = ready.filter((m) => !m.registered);
  if (unregistered.length) {
    for (const p of regions) if (p.connected) p.send({ type: "stop" });
    await sleep(1000);
    for (const p of regions) p.kill();
    world.kill();
    const why = `${unregistered.length}/${n} regions could not register with the world (${unregistered[0].error})`;
    return { regions: n, failedToStart: why, breaches: [why] };
  }
  await sleep(WARMUP_S * 1000);
  for (const p of regions) p.send({ type: "report" }); // reset the counters
  await sleep(300);
  reports.length = 0;
  measuring = true;
  const cpuSamples = [];
  let rssMax = 0;
  let last = procStat(world.pid);
  let lastT = performance.now();
  for (let s = 0; s < WINDOW_S; s++) {
    await sleep(1000);
    const now = procStat(world.pid), t = performance.now();
    cpuSamples.push(((now.cpu - last.cpu) / ((t - lastT) / 1000)) * 100);
    rssMax = Math.max(rssMax, now.rss);
    last = now; lastT = t;
  }
  measuring = false;
  for (const p of regions) p.send({ type: "report" });
  await sleep(500);
  for (const p of regions) p.send({ type: "stop" });
  await Promise.all(regions.map((p) => new Promise((r) => p.once("exit", r))));
  world.kill("SIGTERM");
  await new Promise((r) => world.once("exit", r));

  const ops = {};
  for (const rep of reports) for (const [m, xs] of Object.entries(rep.ops)) (ops[m] ??= []).push(...xs);
  const result = {
    regions: n,
    ops: Object.fromEntries(Object.entries(ops).map(([m, xs]) => [m, { calls: xs.length, p50: r2(pct(xs, 0.5)), p99: r2(pct(xs, 0.99)) }])),
    handoffs: { redirects, accepted, refused, successRate: redirects ? r2(accepted / redirects) : null, p50: r2(pct(handoffs, 0.5)), p99: r2(pct(handoffs, 0.99)), perSec: r2(accepted / WINDOW_S) },
    tickJitterP99Ms: r2(Math.max(...reports.map((r) => r.loopDelayP99Ms))),
    tickP99Ms: r2(Math.max(...reports.map((r) => r.tickP99Ms))),
    worldCpuPct: { avg: r2(cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length), max: r2(Math.max(...cpuSamples)) },
    worldRssMb: r2(rssMax),
    regionErrors: reports.reduce((a, r) => a + Object.values(r.errors).reduce((x, y) => x + y, 0), 0),
  };
  result.breaches = [
    result.handoffs.p99 != null && result.handoffs.p99 > LIMITS.handoffP99Ms && `hand-off p99 ${result.handoffs.p99} ms > ${LIMITS.handoffP99Ms}`,
    result.tickJitterP99Ms > LIMITS.tickJitterMs && `tick jitter ${result.tickJitterP99Ms} ms > ${LIMITS.tickJitterMs}`,
    result.tickP99Ms > LIMITS.tickP99Ms && `region tick p99 ${result.tickP99Ms} ms > ${LIMITS.tickP99Ms}`,
    result.worldCpuPct.avg > LIMITS.worldCpuPct && `world CPU ${result.worldCpuPct.avg}% > ${LIMITS.worldCpuPct}`,
  ].filter(Boolean);
  return result;
}

const results = [];
console.log(`[stress] ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GiB; ${ENTITIES} entities and ${PLAYERS} players per region; ${WINDOW_S} s per step`);
for (const n of SWEEP) {
  const r = await runN(n);
  results.push(r);
  if (r.failedToStart) { console.log(`[stress] N=${n}: BREACH: ${r.failedToStart}`); break; }
  console.log(`[stress] N=${n}: hand-offs ${r.handoffs.accepted}/${r.handoffs.redirects} p50 ${r.handoffs.p50} p99 ${r.handoffs.p99} ms | tick jitter p99 ${r.tickJitterP99Ms} ms, tick p99 ${r.tickP99Ms} ms | world CPU ${r.worldCpuPct.avg}% (max ${r.worldCpuPct.max}), RSS ${r.worldRssMb} MB | heartbeat p99 ${r.ops.Heartbeat?.p99} ms${r.breaches.length ? " | BREACH: " + r.breaches.join("; ") : ""}`);
  if (r.breaches.length) break;
}
const held = results.filter((r) => !r.breaches.length).map((r) => r.regions);
const summary = { machine: { cores: os.cpus().length, model: os.cpus()[0]?.model, memGiB: Math.round(os.totalmem() / 2 ** 30), node: process.version }, config: { WINDOW_S, ENTITIES, PLAYERS, LIMITS }, regionsPerBox: held.length ? Math.max(...held) : 0, results };
fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
console.log(`[stress] regions per box before degradation: ${summary.regionsPerBox}${results.at(-1).breaches.length ? ` (N=${results.at(-1).regions} broke: ${results.at(-1).breaches.join("; ")})` : " (no breach within the sweep)"}; full results in ${OUT}`);
