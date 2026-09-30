/**
 * Transport benchmark: what the port costs the server under game load,
 * uWebSockets.js against ws.
 *
 *   npm run bench:transport -w @mmo-engine/engine-core -- [clients…] [--seconds 8] [--out file.json]
 *
 * For each client count and each transport, a separate process opens that
 * many WebSocket clients to this one. Every tick (30 Hz) the server sends
 * each client a delta-sized binary message (1.2 KB, a busy area's delta)
 * and every client sends an intent (48 B), as a region does. After a
 * warm-up it measures, over the window:
 *
 * - server CPU (user + system, % of one core): the headline;
 * - the broadcast loop's time per tick (p50 / p99, ms): what the tick
 *   budget (33 ms) pays for the fan-out;
 * - resident memory, and messages delivered each way (nothing dropped).
 *
 * It measures the transport alone (no sim, no encoding): the part the
 * socket library decides.
 */

import { fork } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createTransport, loadUws, type WireSocket } from "./transport.js";

const TICK_MS = 1000 / 30;
const DELTA_BYTES = 1200;
const INTENT_BYTES = 48;

interface Result {
  transport: "uws" | "ws";
  clients: number;
  seconds: number;
  cpuPercent: number;
  tickP50Ms: number;
  tickP99Ms: number;
  rssMb: number;
  sentPerSec: number;
  deliveredPerSec: number;
  intentsPerSec: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};

async function runOne(kind: "uws" | "ws", clients: number, seconds: number): Promise<Result> {
  const transport = createTransport(kind);
  const sockets = new Set<WireSocket>();
  let intents = 0;
  const port = await transport.listen(0, {
    connection: (s) => {
      sockets.add(s);
      s.listen({ message: () => void intents++, close: () => sockets.delete(s) });
    },
    http: null,
  });

  const swarm = fork(fileURLToPath(import.meta.url), ["--swarm", String(port), String(clients)], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const swarmMsg = <T>(): Promise<T> => new Promise((r) => swarm.once("message", (m) => r(m as T)));
  await swarmMsg<"ready">();
  while (sockets.size < clients) await sleep(10);

  const delta = new Uint8Array(DELTA_BYTES).map((_, i) => i & 0xff);
  let sent = 0;
  let measuring = false;
  const tickMs: number[] = [];
  const tick = (): void => {
    const t0 = performance.now();
    for (const s of sockets) s.send(delta);
    if (measuring) {
      tickMs.push(performance.now() - t0);
      sent += sockets.size;
    }
  };
  const timer = setInterval(tick, TICK_MS);
  swarm.send("start");
  await sleep(2000); // warm-up

  measuring = true;
  intents = 0;
  swarm.send("reset");
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  await sleep(seconds * 1000);
  const cpu = process.cpuUsage(cpu0);
  const wall = (performance.now() - t0) / 1000;
  measuring = false;
  const intentsSeen = intents;
  const rssMb = process.memoryUsage().rss / 2 ** 20;
  swarm.send("report");
  const { received } = await swarmMsg<{ received: number }>();

  clearInterval(timer);
  swarm.kill();
  await transport.close();
  await sleep(300);

  return {
    transport: kind,
    clients,
    seconds: Math.round(wall * 10) / 10,
    cpuPercent: Math.round(((cpu.user + cpu.system) / 1e6 / wall) * 1000) / 10,
    tickP50Ms: Math.round(quantile(tickMs, 0.5) * 1000) / 1000,
    tickP99Ms: Math.round(quantile(tickMs, 0.99) * 1000) / 1000,
    rssMb: Math.round(rssMb),
    sentPerSec: Math.round(sent / wall),
    deliveredPerSec: Math.round(received / wall),
    intentsPerSec: Math.round(intentsSeen / wall),
  };
}

/** The client side: `n` sockets, each sending an intent per tick and counting what arrives. */
async function swarm(port: number, n: number): Promise<void> {
  const send = (m: unknown): void => void process.send?.(m);
  const conns: WebSocket[] = [];
  let received = 0;
  for (let i = 0; i < n; i += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, n - i) }, () => new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on("message", () => void received++);
        ws.once("open", () => resolve());
        ws.once("error", reject);
        conns.push(ws);
      })),
    );
  }
  const intent = new Uint8Array(INTENT_BYTES);
  let timer: NodeJS.Timeout | null = null;
  process.on("message", (m) => {
    if (m === "start") timer = setInterval(() => { for (const c of conns) c.send(intent); }, TICK_MS);
    if (m === "reset") received = 0;
    if (m === "report") {
      if (timer) clearInterval(timer);
      send({ received });
    }
  });
  send("ready");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--swarm") return swarm(Number(args[1]), Number(args[2]));
  const flag = (name: string, def: string): string => {
    const i = args.indexOf(name);
    if (i < 0) return def;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const seconds = Number(flag("--seconds", "8"));
  const out = flag("--out", "");
  const counts = args.length ? args.map(Number) : [100, 250, 500, 1000];
  const kinds: Array<"uws" | "ws"> = loadUws() ? ["uws", "ws"] : ["ws"];
  const results: Result[] = [];
  for (const clients of counts) {
    for (const kind of kinds) {
      const r = await runOne(kind, clients, seconds);
      results.push(r);
      console.log(
        `${kind.padEnd(3)} ${String(clients).padStart(5)} clients: CPU ${String(r.cpuPercent).padStart(5)}% | ` +
          `broadcast p50 ${r.tickP50Ms} ms, p99 ${r.tickP99Ms} ms | RSS ${r.rssMb} MB | ` +
          `${r.sentPerSec}/s sent, ${r.deliveredPerSec}/s delivered, ${r.intentsPerSec}/s intents in`,
      );
    }
  }
  if (out) writeFileSync(out, JSON.stringify({ tickHz: 30, deltaBytes: DELTA_BYTES, intentBytes: INTENT_BYTES, results }, null, 2) + "\n");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
